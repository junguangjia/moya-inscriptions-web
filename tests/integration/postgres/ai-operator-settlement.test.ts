/**
 * The settlement read of admin-mcp-completion-v1 section 9, under the runtime App role
 * on a disposable database of its own. What the Admin cannot see from its side: which
 * items a subject's operations move, which jobs count, what "newer than the operation"
 * reads, and that a read that fails never answers as settled.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createPostgresPool,
  parsePostgresConfig,
} from "@moya/catalog-postgres";
import {
  PostgresAiOperatorReader,
  runCommunityMigrations,
} from "@moya/community-postgres";
import { emptyArticleDocument } from "@moya/contracts/schemas";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const target = requireSyntheticTestDatabaseUrl();
const guard = await import(
  new URL("../../../scripts/disposable-test-target.mjs", import.meta.url).href
);

type Pool = ReturnType<typeof createPostgresPool>;
const poolFor = (url: string): Pool =>
  createPostgresPool(parsePostgresConfig({ DATABASE_URL: url }));

const run = randomBytes(6).toString("hex");
const admin = poolFor(target);
const database = `ai_settlement_${run}_synthetic_test`;
const role = `ai_settlement_${run}`;
let setup: Pool;
let app: Pool;
let createdDatabase = false;
let createdRole = false;
let reader: PostgresAiOperatorReader;

const hex = () => randomUUID().replaceAll("-", "");
const opaque = (prefix: string) => `${prefix}-${hex()}`;
const sha = () => randomBytes(32).toString("hex");

/** The gates publishing asks. Open here: a gate's own tests shut them. */
const gates = { open: true };
const publication = {
  isPublic: () => gates.open,
  allowPublish: () => gates.open,
};

let sequence = 0;
const newUser = async () => {
  sequence += 1;
  const id = opaque("user");
  await setup.query(
    "INSERT INTO community.public_users(id,handle,display_name) VALUES($1,$2,'Synthetic')",
    [id, `settling-${sequence}-${run}`],
  );
  return id;
};
const newItem = async (owner: string) => {
  const id = opaque("media-item");
  await setup.query(
    "INSERT INTO community.media_items(id,owner_id,kind,quality_mode,source,state,presentation,ready_at) VALUES($1,$2,'static','standard','upload','ready','{\"width\":512,\"height\":384}',CURRENT_TIMESTAMP)",
    [id, owner],
  );
  return id;
};
const newAsset = async (
  column: "item_id" | "catalog_asset_id",
  subject: string,
  desiredAt = "CURRENT_TIMESTAMP",
) => {
  await setup.query(
    `INSERT INTO community.media_public_assets(id,${column},desired_at,created_at,updated_at) VALUES($1,$2,${desiredAt},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [hex(), subject],
  );
};
const newRevision = async (
  work: string,
  author: string,
  items: readonly string[],
  disposition = "approved",
) => {
  sequence += 1;
  const id = opaque("work-revision");
  await setup.query(
    `INSERT INTO community.work_revisions(id,work_id,author_id,sequence,origin,title,body,authorship_kind,requested_visibility,cover_item_id,content_sha256,disposition,submitted_at)
     VALUES($1,$2,$3,$4,'submission','Settling','','original','public',$5,$6,$7,CURRENT_TIMESTAMP)`,
    [id, work, author, sequence, items[0], sha(), disposition],
  );
  for (const [index, item] of items.entries())
    await setup.query(
      `INSERT INTO community.work_revision_items(revision_id,position,item_id,edit) VALUES($1,$2,$3,'{"rotation":0,"crop":null}')`,
      [id, index + 1, item],
    );
  return id;
};
const newWork = async (author: string) => {
  const id = opaque("work");
  await setup.query(
    "INSERT INTO community.works(id,author_id,title,text,created_via,visibility,first_published_at) VALUES($1,$2,'Settling','','publishing','public',CURRENT_TIMESTAMP)",
    [id, author],
  );
  return id;
};
const newArticle = async (owner: string, items: readonly string[]) => {
  const id = opaque("article");
  const document = JSON.stringify({
    ...emptyArticleDocument(),
    references: Object.fromEntries(
      items.map((itemId, index) => [
        `used${index}`,
        { type: "managed", itemId },
      ]),
    ),
  });
  await setup.query(
    "INSERT INTO community.article_documents(id,owner_id,version,title,document,fingerprint,created_at,updated_at) VALUES($1,$2,1,'Settling',$3::jsonb,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    [id, owner, document, "d".repeat(64)],
  );
  for (const [index, item] of items.entries()) {
    await setup.query(
      "INSERT INTO community.article_revisions(article_id,version,owner_id,title,document,fingerprint,submitted_policy,submitted_by_source,created_at) VALUES($1,$2,$3,'Settling',$4::jsonb,$5,'PRE_MODERATION','human',CURRENT_TIMESTAMP)",
      [id, index + 1, owner, document, "d".repeat(64)],
    );
    await setup.query(
      `INSERT INTO community.media_item_refs(item_id,holder_kind,holder_id)
       VALUES($1,'article_revision','article-revision-'||substr(encode(sha256(convert_to($2||':'||$3::text,'UTF8')),'hex'),1,32))`,
      [item, id, index + 1],
    );
  }
  return id;
};
const newJob = async (
  subject: string,
  kind: string,
  state: string,
  age = "0 seconds",
) => {
  const id = opaque("publishing-job");
  const running = state === "running";
  await setup.query(
    `INSERT INTO community.publishing_jobs(id,kind,subject_id,state,attempts,lease_owner,lease_expires_at,run_after,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP-$8::interval,CURRENT_TIMESTAMP-$8::interval)`,
    [
      id,
      kind,
      subject,
      state,
      running ? 1 : 0,
      running ? "synthetic-worker" : null,
      running ? new Date(Date.now() + 3_600_000).toISOString() : null,
      age,
    ],
  );
  return id;
};
const settle = (type: "work" | "article" | "user" | "item", id: string) =>
  reader.settlement({ type, id, intent: "withdraw" });

beforeAll(async () => {
  const probe = await admin.query(guard.disposableTestTargetProbeSql);
  guard.assertDisposableTestTarget(
    probe.rows,
    decodeURI(new URL(target).pathname.slice(1)),
  );
  const password = randomBytes(32).toString("hex");
  await admin.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
  );
  createdRole = true;
  await admin.query(`CREATE DATABASE ${database}`);
  createdDatabase = true;
  const url = new URL(target);
  url.pathname = `/${database}`;
  setup = poolFor(url.toString());
  await runCommunityMigrations(setup, `${root}/database/community-migrations`);
  await setup.query(
    "CREATE TABLE public.catalog_entries(catalog_id text PRIMARY KEY,province text,province_state text); CREATE TABLE public.catalog_discovery(catalog_id text PRIMARY KEY,kind text,title text,aliases varchar[],first_published_at timestamptz,filter_metadata jsonb); CREATE TABLE public.catalog_media(catalog_id text,media_id text,object_key text,width integer,height integer,is_representative boolean,position integer NOT NULL DEFAULT 0); CREATE TABLE public.article_entries(article_id text PRIMARY KEY,title text)",
  );
  await setup.query(
    (
      await readFile(
        `${root}/infra/development/work-publishing/grant-runtime.sql`,
        "utf8",
      )
    ).replaceAll(':"app_role"', `"${role}"`),
  );
  url.username = role;
  url.password = password;
  app = poolFor(url.toString());
  reader = new PostgresAiOperatorReader(app, publication);
}, 120_000);

beforeEach(() => {
  gates.open = true;
});

afterAll(async () => {
  await app?.end();
  await setup?.end();
  try {
    if (createdDatabase) await admin.query(`DROP DATABASE ${database}`);
  } finally {
    try {
      if (createdRole) await admin.query(`DROP ROLE ${role}`);
    } finally {
      await admin.end();
    }
  }
});

describe("the items behind a subject", () => {
  it("reads a work's across all its revisions, and no one else's", async () => {
    const author = await newUser();
    const work = await newWork(author);
    const old = await newItem(author);
    const current = await newItem(author);
    const pending = await newItem(author);
    await newRevision(work, author, [old]);
    const revision = await newRevision(work, author, [current]);
    await newRevision(work, author, [pending], "pending");
    await setup.query(
      "UPDATE community.works SET public_revision_id=$2 WHERE id=$1",
      [work, revision],
    );
    const elsewhere = await newItem(author);
    await newRevision(await newWork(author), author, [elsewhere]);
    await newJob(elsewhere, "withdraw_media", "queued");
    expect(await settle("work", work)).toEqual({
      open: 0,
      failed: 0,
      failedJobs: [],
    });
    // The one a new public revision replaced is what an approval withdraws.
    await newJob(old, "withdraw_media", "queued");
    await newJob(current, "publish_media", "running");
    await newJob(pending, "publish_media", "queued");
    expect(await settle("work", work)).toMatchObject({ open: 3 });
  });

  it("reads an Article's across its revisions", async () => {
    const owner = await newUser();
    const [first, second] = [await newItem(owner), await newItem(owner)];
    const article = await newArticle(owner, [first, second]);
    const unrelated = await newItem(owner);
    await newJob(unrelated, "withdraw_media", "queued");
    expect(await settle("article", article)).toMatchObject({ open: 0 });
    await newJob(first, "withdraw_media", "queued");
    await newJob(second, "publish_media", "queued");
    expect(await settle("article", article)).toMatchObject({ open: 2 });
  });

  it("reads a user's whole set", async () => {
    const user = await newUser();
    const [first, second] = [await newItem(user), await newItem(user)];
    await newJob(await newItem(await newUser()), "withdraw_media", "queued");
    expect(await settle("user", user)).toMatchObject({ open: 0 });
    await newJob(first, "withdraw_media", "queued");
    await newJob(second, "withdraw_media", "running");
    expect(await settle("user", user)).toMatchObject({ open: 2 });
  });

  it("reads a job's own subject, a media item or a Catalog asset", async () => {
    const item = await newItem(await newUser());
    await newJob(item, "publish_media", "queued");
    expect(await settle("item", item)).toMatchObject({ open: 1 });
    const mediaId = `media_${hex()}`;
    const key = `display/v1/media_${hex()}/${sha()}.webp`;
    const { id: asset } = (
      await setup.query<{ id: string }>(
        `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key)
         VALUES('catalog-asset-'||md5($1||':'||$2),$1,$2) RETURNING id`,
        [mediaId, key],
      )
    ).rows[0]!;
    expect(await settle("item", asset)).toMatchObject({ open: 0 });
    await newJob(asset, "withdraw_media", "queued");
    expect(await settle("item", asset)).toMatchObject({ open: 1 });
  });

  it("answers not_found rather than settled for a subject that is not there", async () => {
    for (const [type, prefix] of [
      ["work", "work"],
      ["article", "article"],
      ["user", "user"],
      ["item", "media-item"],
    ] as const)
      expect(await settle(type, opaque(prefix)), type).toBe("not_found");
  });
});

describe("which jobs count", () => {
  it("counts publish, withdraw and verification, and nothing else on the item", async () => {
    const item = await newItem(await newUser());
    for (const kind of ["process_item", "derive_edit", "purge_item"])
      await newJob(item, kind, "queued");
    expect(await settle("item", item)).toMatchObject({ open: 0 });
    for (const kind of ["publish_media", "withdraw_media", "verify_withdrawal"])
      await newJob(item, kind, "queued");
    expect(await settle("item", item)).toMatchObject({ open: 3 });
  });

  it("reads a success as finished and nothing as open", async () => {
    const item = await newItem(await newUser());
    await newAsset("item_id", item);
    await newJob(item, "withdraw_media", "succeeded");
    expect(await settle("item", item)).toEqual({
      open: 0,
      failed: 0,
      failedJobs: [],
    });
  });

  it("reads failed and abandoned as stopped, the newest first and at most three", async () => {
    const item = await newItem(await newUser());
    await newAsset("item_id", item, "CURRENT_TIMESTAMP-interval '1 hour'");
    const oldest = await newJob(
      item,
      "withdraw_media",
      "abandoned",
      "4 seconds",
    );
    const third = await newJob(item, "publish_media", "failed", "3 seconds");
    const second = await newJob(
      item,
      "verify_withdrawal",
      "abandoned",
      "2 seconds",
    );
    const first = await newJob(item, "withdraw_media", "failed", "1 second");
    const answer = await settle("item", item);
    expect(answer).toEqual({
      open: 0,
      failed: 4,
      failedJobs: [first, second, third],
    });
    expect(JSON.stringify(answer)).not.toContain(oldest);
  });
});

describe("newer than the operation", () => {
  it("reads a stop past the asset's fence, and within the clock's margin before it", async () => {
    const item = await newItem(await newUser());
    await newAsset("item_id", item, "CURRENT_TIMESTAMP-interval '10 minutes'");
    await newJob(item, "withdraw_media", "failed", "9 minutes");
    expect(await settle("item", item)).toMatchObject({ failed: 1 });

    const margin = await newItem(await newUser());
    await newAsset(
      "item_id",
      margin,
      "CURRENT_TIMESTAMP-interval '10 minutes'",
    );
    await newJob(margin, "withdraw_media", "failed", "10 minutes 30 seconds");
    expect(await settle("item", margin)).toMatchObject({ failed: 1 });
  });

  it("does not read a stop from before the operation", async () => {
    const item = await newItem(await newUser());
    await newAsset("item_id", item, "CURRENT_TIMESTAMP-interval '10 minutes'");
    await newJob(item, "withdraw_media", "failed", "12 minutes");
    expect(await settle("item", item)).toEqual({
      open: 0,
      failed: 0,
      failedJobs: [],
    });
  });

  it("does not read a stop a later job of its side has got past", async () => {
    const item = await newItem(await newUser());
    await newAsset("item_id", item, "CURRENT_TIMESTAMP-interval '1 hour'");
    await newJob(item, "withdraw_media", "failed", "10 minutes");
    await newJob(item, "withdraw_media", "succeeded", "5 minutes");
    expect(await settle("item", item)).toMatchObject({ failed: 0 });

    const verified = await newItem(await newUser());
    await newAsset("item_id", verified, "CURRENT_TIMESTAMP-interval '1 hour'");
    await newJob(verified, "verify_withdrawal", "failed", "10 minutes");
    await newJob(verified, "withdraw_media", "succeeded", "5 minutes");
    expect(await settle("item", verified)).toMatchObject({ failed: 0 });
  });

  it("still reads it past an earlier success, or a success of the other side", async () => {
    const item = await newItem(await newUser());
    await newAsset("item_id", item, "CURRENT_TIMESTAMP-interval '1 hour'");
    await newJob(item, "withdraw_media", "succeeded", "20 minutes");
    await newJob(item, "withdraw_media", "failed", "10 minutes");
    expect(await settle("item", item)).toMatchObject({ failed: 1 });

    const sides = await newItem(await newUser());
    await newAsset("item_id", sides, "CURRENT_TIMESTAMP-interval '1 hour'");
    await newJob(sides, "publish_media", "failed", "10 minutes");
    await newJob(sides, "withdraw_media", "succeeded", "5 minutes");
    expect(await settle("item", sides)).toMatchObject({ failed: 1 });
  });

  it("reads a Catalog asset's fence the same way", async () => {
    const { id: asset } = (
      await setup.query<{ id: string }>(
        `INSERT INTO community.catalog_media_assets(id,media_id,source_object_key)
         VALUES('catalog-asset-'||md5($1||':'||$2),$1,$2) RETURNING id`,
        [`media_${hex()}`, `display/v1/media_${hex()}/${sha()}.webp`],
      )
    ).rows[0]!;
    await newAsset(
      "catalog_asset_id",
      asset,
      "CURRENT_TIMESTAMP-interval '10 minutes'",
    );
    await newJob(asset, "withdraw_media", "failed", "12 minutes");
    expect(await settle("item", asset)).toMatchObject({ failed: 0 });
    await newJob(asset, "publish_media", "failed", "1 minute");
    expect(await settle("item", asset)).toMatchObject({ failed: 1 });
  });
});

describe("the publish gates", () => {
  const publishing = (id: string) =>
    reader.settlement({ type: "user", id, intent: "publish" });

  it("say off for a publish with either gate shut, and nothing otherwise", async () => {
    const user = await newUser();
    expect(await publishing(user)).not.toHaveProperty("mediaGate");
    gates.open = false;
    expect(await publishing(user)).toMatchObject({ mediaGate: "off" });
    // Withdrawal runs whatever the gates say.
    expect(await settle("user", user)).not.toHaveProperty("mediaGate");
    const one = new PostgresAiOperatorReader(app, {
      isPublic: () => true,
      allowPublish: () => false,
    });
    expect(
      await one.settlement({ type: "user", id: user, intent: "publish" }),
    ).toMatchObject({ mediaGate: "off" });
    const other = new PostgresAiOperatorReader(app, {
      isPublic: () => false,
      allowPublish: () => true,
    });
    expect(
      await other.settlement({ type: "user", id: user, intent: "publish" }),
    ).toMatchObject({ mediaGate: "off" });
  });

  it("read as shut with no gates given, as publishing does", async () => {
    expect(
      await new PostgresAiOperatorReader(app).settlement({
        type: "user",
        id: await newUser(),
        intent: "publish",
      }),
    ).toMatchObject({ mediaGate: "off" });
  });

  it("say so beside work that is still open", async () => {
    const user = await newUser();
    await newJob(await newItem(user), "withdraw_media", "queued");
    gates.open = false;
    expect(await publishing(user)).toMatchObject({
      open: 1,
      mediaGate: "off",
    });
  });
});

describe("what the Owner holds", () => {
  it("answers self_only for a self-only work, its item, and an Article using it", async () => {
    const author = await newUser();
    const work = await newWork(author);
    const item = await newItem(author);
    await newRevision(work, author, [item]);
    const article = await newArticle(author, [item]);
    await setup.query(
      "UPDATE community.article_documents SET version=2,status='pending',pending_version=1 WHERE id=$1",
      [article],
    );
    await newJob(item, "withdraw_media", "queued");
    expect(await settle("work", work)).toMatchObject({ open: 1 });
    expect(await settle("item", item)).toMatchObject({ open: 1 });
    expect(await settle("article", article)).toMatchObject({ open: 1 });
    await setup.query(
      "UPDATE community.works SET visibility='self' WHERE id=$1",
      [work],
    );
    expect(await settle("work", work)).toBe("self_only");
    expect(await settle("item", item)).toBe("self_only");
    expect(await settle("article", article)).toBe("self_only");
    // Its author's other work and the count of their items stay readable.
    expect(await settle("user", author)).toMatchObject({ open: 1 });
    await setup.query(
      "UPDATE community.works SET visibility='public' WHERE id=$1",
      [work],
    );
    expect(await settle("work", work)).toMatchObject({ open: 1 });
  });

  it("does not hold a work its author deleted", async () => {
    const author = await newUser();
    const work = await newWork(author);
    const item = await newItem(author);
    await newRevision(work, author, [item]);
    await newJob(item, "withdraw_media", "queued");
    await setup.query(
      "UPDATE community.works SET title='',text='',media_ids='{}',public_revision_id=NULL,author_revision_id=NULL,visibility='self',deleted_at=CURRENT_TIMESTAMP WHERE id=$1",
      [work],
    );
    expect(await settle("work", work)).toMatchObject({ open: 1 });
  });
});

describe("a read that fails", () => {
  it("answers timed_out when the statement runs out of time, and never settled", async () => {
    const item = await newItem(await newUser());
    const holder = await setup.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "LOCK TABLE community.publishing_jobs IN ACCESS EXCLUSIVE MODE",
      );
      expect(await settle("item", item)).toBe("timed_out");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 20_000);

  it("throws when the store cannot be reached, and never settled", async () => {
    const url = new URL(target);
    url.port = "1";
    const gone = poolFor(url.toString());
    await expect(
      new PostgresAiOperatorReader(gone).settlement({
        type: "user",
        id: opaque("user"),
        intent: "withdraw",
      }),
    ).rejects.toThrow();
    await gone.end();
  }, 20_000);
});
