/** Run with the installed Payload CLI, a task-private synthetic env and one
 * artifact-directory argument. This is the frozen Phase 4 acceptance fixture,
 * not a general import tool or a public work-creation operation. */
import process from "node:process";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  PostgresAuthorCommunityAdapter,
  PostgresCommunityContentOperatorAdapter,
  PostgresCommunityCommentAdapter,
  PostgresWorkPublishingAdapter,
} from "../services/community-postgres/dist/index.js";
import {
  editorialPublishSchema,
  catalogFilterMetadataSchema,
} from "../packages/contracts/dist/internal/editorial/index.js";

const task = "phase4-author-community-v1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.resolve(process.argv[2] ?? ".");
const frozenHash =
  "b1af83f3df1dee1dcd7e6a2db87f1a9b7a676ed81baf84b11cd0c4ec400b3089";
const portableHash =
  "ed068b2d940807783d3817f3ba708df4606fd43f07476bd0e32367336966993a";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const safeRead = (filename, privateFile = false) => {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const st = fs.fstatSync(fd);
    assert(
      st.isFile() && st.size <= 8 * 1024 * 1024,
      "REGULAR_BOUNDED_FILE_REQUIRED",
    );
    if (privateFile)
      assert(
        st.uid === process.getuid() && (st.mode & 0o777) === 0o600,
        "PRIVATE_FILE_REQUIRED",
      );
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const json = (filename, privateFile = false) =>
  JSON.parse(safeRead(filename, privateFile).toString("utf8"));
const base = path.join(artifact, "infrastructure/acceptance");
const journalPath = path.join(artifact, "synthetic/seed-journal.json");
let payload, pool, ownerDb, journal;
let step = "preflight";
const counters = { users: 0, catalogs: 0, works: 0, media: 0, support: 0 };
function saveJournal() {
  const temporary = journalPath + "." + randomUUID() + ".next";
  fs.writeFileSync(temporary, JSON.stringify(journal, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, journalPath);
}
async function once(key, operation) {
  if (journal.steps[key]?.done) return journal.steps[key].result;
  if (!journal.steps[key]) {
    journal.steps[key] = { requestId: randomUUID() };
    saveJournal();
  }
  step = key;
  const result = await operation(journal.steps[key].requestId);
  journal.steps[key] = {
    ...journal.steps[key],
    done: true,
    result: result ?? null,
  };
  saveJournal();
  return result;
}
const filtersFor = (facts) =>
  catalogFilterMetadataSchema.parse(
    Object.fromEntries(
      ["dynasty", "textAuthor", "calligrapher", "originalRegion", "script"].map(
        (name) => {
          if (name === "textAuthor" || name === "calligrapher") {
            const names = facts.contributors
              .filter((item) => item.role === name)
              .map((item) => item.normalized);
            return [
              name,
              {
                state: names.length ? "VALUE" : "UNSUPPLIED",
                tokens: names.join("\n"),
              },
            ];
          }
          const value = facts[name];
          return [
            name,
            {
              state: value.state,
              tokens:
                value.state === "VALUE" ? value.normalized.join("\n") : "",
            },
          ];
        },
      ),
    ),
  );
async function main() {
  process.umask(0o077);
  assert(
    process.argv.length === 3 && path.basename(artifact) === task,
    "TASK_ARTIFACT_ARGUMENT_REQUIRED",
  );
  assert(
    process.env.CMS_ENVIRONMENT === "synthetic" &&
      process.env.NODE_ENV !== "production",
    "SYNTHETIC_DEVELOPMENT_REQUIRED",
  );
  const target = json(path.join(base, "seed-target.json"), true);
  assert(
    target.task === task &&
      target.host === "127.0.0.1" &&
      target.port === 54341 &&
      target.database === "yoyi_dev",
    "TASK_TARGET_MISMATCH",
  );
  const configured = new URL(process.env.CMS_DATABASE_URL ?? "invalid:");
  assert(
    configured.hostname === target.host &&
      configured.port === String(target.port) &&
      configured.pathname === "/" + target.database &&
      configured.username === "yoyi_dev_payload",
    "PAYLOAD_TARGET_MISMATCH",
  );
  // The task-private provenance checker validates container, volume, labels,
  // loopback mapping, cluster, migration checksums and published view hashes.
  const check = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(base, "grants/run.mjs"), "check"],
      {
        encoding: "utf8",
        timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  assert(
    check.runtimeGrantPlan === "VERIFIED" &&
      check.containerId === target.containerId,
    "PROVENANCE_CHECK_FAILED",
  );
  const manifestBytes = safeRead(
    path.join(artifact, "synthetic/manifest.json"),
  );
  const manifestHash = hash(manifestBytes);
  assert(
    manifestHash === frozenHash || manifestHash === portableHash,
    "FROZEN_MANIFEST_MISMATCH",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert(
    manifest.taskId === task &&
      manifest.catalogs.length === 10 &&
      manifest.works.length === 10 &&
      manifest.accounts.length === 6 &&
      manifest.media.length === 25,
    "FROZEN_COUNTS_MISMATCH",
  );
  const allIds = [
    ...manifest.accounts.map((x) => x.id),
    ...manifest.catalogs.flatMap((x) => [x.catalogId, x.sourceId]),
    ...manifest.works.map((x) => x.id),
    ...manifest.media.map((x) => x.mediaId),
  ];
  assert(new Set(allIds).size === allIds.length, "IDENTITIES_NOT_INDEPENDENT");
  const mediaById = new Map();
  for (const asset of manifest.media) {
    const filename = path.resolve(artifact, "synthetic", asset.file);
    assert(
      filename.startsWith(path.join(artifact, "synthetic/images") + path.sep) &&
        (asset.filePath === undefined || filename === asset.filePath),
      "MEDIA_PATH_MISMATCH",
    );
    const bytes = safeRead(filename);
    assert(
      hash(bytes) === asset.sha256 &&
        bytes.length === asset.byteLength &&
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.readUInt32BE(16) === asset.width &&
        bytes.readUInt32BE(20) === asset.height,
      "FROZEN_MEDIA_MISMATCH",
    );
    assert(
      asset.owner.type === "user"
        ? manifest.accounts.some((x) => x.id === asset.owner.userId)
        : manifest.catalogs.some((x) => x.catalogId === asset.owner.catalogId),
      "MEDIA_OWNER_MISMATCH",
    );
    mediaById.set(asset.mediaId, { ...asset, bytes });
  }
  for (const item of [...manifest.catalogs, ...manifest.works])
    for (const id of item.mediaIds) {
      const asset = mediaById.get(id);
      assert(
        asset &&
          (item.catalogId
            ? asset.owner.catalogId === item.catalogId
            : asset.owner.userId === item.authorId),
        "CONTENT_MEDIA_OWNERSHIP_MISMATCH",
      );
    }
  const credentials = json(path.join(base, "credentials.json"), true);
  assert(
    credentials.host === target.host &&
      credentials.port === target.port &&
      credentials.database === target.database &&
      credentials.owner === "yoyi_dev_owner",
    "OWNER_TARGET_MISMATCH",
  );
  const require = createRequire(
    path.join(root, "services/community-postgres/package.json"),
  );
  const { Pool, Client } = require("pg");
  const connection = (role) => ({
    host: target.host,
    port: target.port,
    database: target.database,
    user: role,
    password: credentials.passwords[role],
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    application_name: task + "-seed",
  });
  ownerDb = new Client(connection(credentials.owner));
  await ownerDb.connect();
  const identity = (
    await ownerDb.query(
      "SELECT current_database() AS database,current_user AS role,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier",
    )
  ).rows[0];
  assert(
    identity.database === target.database &&
      identity.role === credentials.owner &&
      identity.system_identifier === target.system_identifier,
    "DATABASE_IDENTITY_MISMATCH",
  );
  assert(
    (
      await ownerDb.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [task + ":frozen-seed"],
      )
    ).rows[0].acquired,
    "SEED_WRITER_ALREADY_ACTIVE",
  );
  if (fs.existsSync(journalPath)) {
    journal = json(journalPath, true);
    assert(
      journal.manifestSha256 === manifestHash &&
        JSON.stringify(journal.target) === JSON.stringify(target),
      "JOURNAL_TARGET_MISMATCH",
    );
  } else {
    journal = {
      version: 1,
      task,
      manifestSha256: manifestHash,
      target,
      startedAt: new Date().toISOString(),
      steps: {},
      publication: {},
    };
    saveJournal();
  }
  pool = new Pool({ ...connection("yoyi_dev_app"), max: 3 });
  const authors = new PostgresAuthorCommunityAdapter(pool);
  const operator = new PostgresCommunityContentOperatorAdapter(pool);
  const { getPayload, createLocalReq } =
    await import("../apps/admin/node_modules/payload/dist/index.js");
  const { default: config } = await import("../apps/admin/payload.config.ts");
  const { selectedMediaSnapshot } =
    await import("../apps/admin/src/media/snapshot.ts");
  payload = await getPayload({ config });
  const ownerEmail = "phase4-owner@synthetic.invalid";
  const ownerId = await once("payload-owner", async () => {
    const existing = await payload.find({
      collection: "users",
      overrideAccess: true,
      where: { email: { equals: ownerEmail } },
      limit: 2,
    });
    if (existing.totalDocs === 1) {
      assert(existing.docs[0].role === "owner", "SYNTHETIC_OWNER_COLLISION");
      return existing.docs[0].id;
    }
    assert(
      existing.totalDocs === 0 &&
        (
          await payload.count({
            collection: "users",
            overrideAccess: true,
            where: { role: { not_equals: "ai_operator" } },
          })
        ).totalDocs === 0,
      "SYNTHETIC_OWNER_BOOTSTRAP_NOT_EMPTY",
    );
    const owner = await payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: ownerEmail,
        password: safeRead(path.join(base, "owner-password"), true)
          .toString("utf8")
          .trim(),
        role: "owner",
        scopeCatalogIds: [],
      },
    });
    return owner.id;
  });
  const owner = await payload.findByID({
    collection: "users",
    id: ownerId,
    overrideAccess: true,
  });
  assert(
    owner.email === ownerEmail && owner.role === "owner",
    "RECORDED_OWNER_CHANGED",
  );
  const req = await createLocalReq(
    { user: { ...owner, collection: "users" } },
    payload,
  );
  for (const account of manifest.accounts)
    await once("account:" + account.id, async () => {
      await ownerDb.query("BEGIN");
      try {
        const prior = (
          await ownerDb.query(
            "SELECT u.*,d.label FROM community.public_users u LEFT JOIN community.development_accounts d ON d.user_id=u.id WHERE u.id=$1 OR u.handle=$2",
            [account.id, account.handle],
          )
        ).rows;
        if (prior.length)
          assert(
            prior.length === 1 &&
              prior[0].id === account.id &&
              prior[0].handle === account.handle &&
              prior[0].label === account.developmentAccountLabel,
            "ACCOUNT_COLLISION",
          );
        else {
          const p = account.privacy;
          await ownerDb.query(
            "INSERT INTO community.public_users(id,handle,display_name,bio,status,following_privacy,followers_privacy,favorites_privacy,likes_privacy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              account.id,
              account.handle,
              account.displayName,
              account.bio,
              account.status,
              p.following,
              p.followers,
              p.favorites,
              p.likes,
            ],
          );
          await ownerDb.query(
            "INSERT INTO community.development_accounts(user_id,label) VALUES($1,$2)",
            [account.id, account.developmentAccountLabel],
          );
          counters.users++;
        }
        await ownerDb.query("COMMIT");
      } catch (error) {
        await ownerDb.query("ROLLBACK");
        throw error;
      }
    });
  for (const asset of mediaById.values())
    await once("media:" + asset.mediaId, async (requestId) => {
      if (asset.owner.type === "user") {
        const existing = (
          await ownerDb.query(
            "SELECT owner_id,sha256,width,height,bytes FROM community.user_media WHERE id=$1",
            [asset.mediaId],
          )
        ).rows[0];
        if (existing)
          assert(
            existing.owner_id === asset.owner.userId &&
              existing.sha256 === asset.sha256 &&
              hash(existing.bytes) === asset.sha256 &&
              existing.width === asset.width &&
              existing.height === asset.height,
            "USER_MEDIA_COLLISION",
          );
        else {
          await authors.saveMedia({
            requestId,
            id: asset.mediaId,
            ownerId: asset.owner.userId,
            bytes: asset.bytes,
            width: asset.width,
            height: asset.height,
            sha256: asset.sha256,
          });
          counters.media++;
        }
        return { mediaId: asset.mediaId, sha256: asset.sha256 };
      }
      const existing = await payload.find({
        collection: "media",
        overrideAccess: false,
        req,
        where: { mediaId: { equals: asset.mediaId } },
        limit: 2,
      });
      assert(existing.totalDocs < 2, "CATALOG_MEDIA_COLLISION");
      const doc =
        existing.docs[0] ??
        (await payload.create({
          collection: "media",
          overrideAccess: false,
          req,
          data: {
            mediaId: asset.mediaId,
            catalogId: asset.owner.catalogId,
            origin: "upload",
            objectKey: "",
            sha256: "",
            alt: asset.alt,
            rights: asset.rights,
            orderConfidence: asset.orderConfidence,
          },
          file: {
            name: "synthetic.png",
            data: asset.bytes,
            mimetype: "image/png",
            size: asset.bytes.length,
          },
        }));
      assert(
        doc.catalogId === asset.owner.catalogId &&
          doc.sha256 === asset.sha256 &&
          doc.width === asset.width &&
          doc.height === asset.height,
        "CATALOG_MEDIA_IDENTITY_MISMATCH",
      );
      assert(
        typeof doc.filename === "string" &&
          path.basename(doc.filename) === doc.filename &&
          hash(safeRead(path.join(process.env.CMS_MEDIA_DIR, doc.filename))) ===
            asset.sha256,
        "CATALOG_STORED_BYTES_MISMATCH",
      );
      if (!existing.totalDocs) counters.media++;
      return {
        nativeId: doc.id,
        mediaId: doc.mediaId,
        objectKey: doc.objectKey,
        sha256: doc.sha256,
        filename: doc.filename,
      };
    });
  const events = [
    ...manifest.catalogs.map((item) => ({
      type: "catalog",
      id: item.catalogId,
      item,
    })),
    ...manifest.works.map((item) => ({ type: "work", id: item.id, item })),
  ].sort((a, b) => a.item.firstPublicationOrder - b.item.firstPublicationOrder);
  assert(
    events.every(
      (event, index) => event.item.firstPublicationOrder === index + 1,
    ),
    "PUBLICATION_ORDINAL_MISMATCH",
  );
  let gap = false,
    previousTime = null;
  for (const event of events) {
    const item = event.item;
    const prior =
      event.type === "catalog"
        ? (
            await ownerDb.query(
              "SELECT c.id,c.source_id,c.owner_note,p.first_published_at FROM public.catalogs c JOIN public.catalog_first_publications p ON p.catalog_id=c.catalog_id WHERE c.catalog_id=$1",
              [event.id],
            )
          ).rows[0]
        : (
            await ownerDb.query("SELECT * FROM community.works WHERE id=$1", [
              event.id,
            ])
          ).rows[0];
    if (prior) {
      assert(!gap, "PUBLICATIONS_NOT_CONTIGUOUS");
      assert(
        event.type === "catalog"
          ? prior.source_id === item.sourceId &&
              prior.owner_note === item.editorialData.ownerNote
          : prior.author_id === item.authorId &&
              prior.synthetic_provenance === item.syntheticProvenance,
        "PRIMARY_IDENTITY_COLLISION",
      );
    } else gap = true;
    if (previousTime) {
      const elapsed = (
        await ownerDb.query(
          "SELECT clock_timestamp()>$1::timestamptz AS later",
          [previousTime],
        )
      ).rows[0].later;
      assert(elapsed, "PUBLICATION_CLOCK_NOT_ADVANCING");
    }
    const timestamp = await once("publication:" + event.id, async () => {
      if (prior) return prior.first_published_at.toISOString();
      if (event.type === "catalog") {
        const snapshots = [];
        for (const id of item.mediaIds) {
          const doc = await payload.findByID({
            collection: "media",
            id: journal.steps["media:" + id].result.nativeId,
            overrideAccess: false,
            req,
          });
          const snapshot = selectedMediaSnapshot(
            doc,
            item.catalogId,
            snapshots,
          );
          assert(snapshot, "DUPLICATE_MEDIA_SNAPSHOT");
          snapshots.push(snapshot);
        }
        const content = editorialPublishSchema.parse({
          ...item.editorialData,
          filterMetadata: filtersFor(item.discoveryFacts),
          media: snapshots,
        });
        await payload.create({
          collection: "catalogs",
          overrideAccess: false,
          req,
          user: req.user,
          depth: 0,
          draft: false,
          data: { ...content, _status: "published", revision: 0 },
        });
        counters.catalogs++;
        return (
          await ownerDb.query(
            "SELECT first_published_at FROM public.catalog_first_publications WHERE catalog_id=$1",
            [event.id],
          )
        ).rows[0].first_published_at.toISOString();
      }
      // A direct legacy insert: the works_legacy_bridge trigger gives it its
      // legacy public and author revision in this statement.
      const row = (
        await ownerDb.query(
          "INSERT INTO community.works(id,author_id,title,text,media_ids,first_published_at,version,operator_state,synthetic_provenance) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,1,'visible',$6) RETURNING first_published_at",
          [
            item.id,
            item.authorId,
            item.title,
            item.text,
            item.mediaIds,
            item.syntheticProvenance,
          ],
        )
      ).rows[0];
      counters.works++;
      return row.first_published_at.toISOString();
    });
    assert(
      !previousTime || timestamp > previousTime,
      "PUBLICATION_ORDER_MISMATCH",
    );
    if (prior)
      assert(
        prior.first_published_at.toISOString() === timestamp,
        "FIRST_PUBLICATION_CHANGED",
      );
    journal.publication[event.id] = {
      ordinal: item.firstPublicationOrder,
      effectiveFirstPublishedAt: timestamp,
    };
    saveJournal();
    previousTime = timestamp;
  }
  for (const rel of manifest.relationships.follows)
    await once("follow:" + rel.followerId + ":" + rel.followedId, (requestId) =>
      authors.follow(rel.followerId, {
        requestId,
        targetId: rel.followedId,
        enabled: true,
      }),
    );
  for (const rel of manifest.relationships.blocks)
    await once("block:" + rel.blockerId + ":" + rel.blockedId, (requestId) =>
      authors.block(rel.blockerId, {
        requestId,
        targetId: rel.blockedId,
        enabled: true,
      }),
    );
  for (const rel of manifest.relationships.initialFavorites)
    await once("favorite:" + rel.userId + ":" + rel.target.id, (requestId) =>
      authors.changeRelation(rel.userId, "favorite", {
        requestId,
        target: rel.target,
        enabled: true,
      }),
    );
  for (const featured of manifest.featured.items)
    await once("featured:" + featured.target.id, (requestId) =>
      operator.setFeatured("phase4-synthetic-seed", {
        requestId,
        ...featured,
        expectedVersion: 0,
        enabled: true,
      }),
    );
  await once("featured-quantity", async (requestId) => {
    // The expected version is frozen before sending; replay after an uncertain
    // commit uses exactly the same command even after operator acceptance edits.
    if (!journal.featuredSettingsVersion) {
      journal.featuredSettingsVersion = (
        await ownerDb.query(
          "SELECT version FROM community.featured_settings WHERE id=TRUE",
        )
      ).rows[0].version;
      saveJournal();
    }
    return operator.setFeaturedQuantity("phase4-synthetic-seed", {
      requestId,
      enabledQuantity: manifest.featured.enabledQuantity,
      expectedVersion: journal.featuredSettingsVersion,
    });
  });
  const { seedSupport } = await import("./seed-phase4-support.mjs");
  await seedSupport({
    manifest,
    journal,
    saveJournal,
    once,
    ownerDb,
    publishing: new PostgresWorkPublishingAdapter(pool),
    discussion: new PostgresCommunityCommentAdapter(pool),
    counters,
  });
  step = "verify";
  // This dedicated acceptance target must contain exactly the frozen primary
  // sets. Extra rows cause a reportable collision; they are never removed.
  const catalogRows = (
    await ownerDb.query("SELECT catalog_id,source_id FROM public.catalogs")
  ).rows;
  const workRows = (
    await ownerDb.query(
      "SELECT id,author_id,synthetic_provenance FROM community.works",
    )
  ).rows;
  assert(
    catalogRows.length === 10 && workRows.length === 10,
    "PRIMARY_COUNTS_CHANGED",
  );
  for (const row of catalogRows)
    assert(
      manifest.catalogs.some(
        (x) => x.catalogId === row.catalog_id && x.sourceId === row.source_id,
      ),
      "CATALOG_IDENTITY_CHANGED",
    );
  for (const row of workRows)
    assert(
      manifest.works.some(
        (x) =>
          x.id === row.id &&
          x.authorId === row.author_id &&
          x.syntheticProvenance === row.synthetic_provenance,
      ),
      "WORK_IDENTITY_CHANGED",
    );
  // Every seeded work is served through its revisions (the legacy bridge
  // gave each one; later acceptance edits keep an author revision).
  assert(
    (
      await ownerDb.query(
        "SELECT count(*)::int AS n FROM community.works w JOIN community.work_revisions r ON r.id=w.author_revision_id AND r.work_id=w.id",
      )
    ).rows[0].n === 10,
    "WORK_REVISIONS_MISSING",
  );
  for (const asset of mediaById.values()) {
    if (asset.owner.type === "user") {
      const row = (
        await ownerDb.query(
          "SELECT owner_id,bytes FROM community.user_media WHERE id=$1",
          [asset.mediaId],
        )
      ).rows[0];
      assert(
        row &&
          row.owner_id === asset.owner.userId &&
          hash(row.bytes) === asset.sha256,
        "USER_MEDIA_CHANGED",
      );
    } else
      assert(
        hash(
          safeRead(
            path.join(
              process.env.CMS_MEDIA_DIR,
              journal.steps["media:" + asset.mediaId].result.filename,
            ),
          ),
        ) === asset.sha256,
        "CATALOG_MEDIA_CHANGED",
      );
  }
  journal.completedAt ??= new Date().toISOString();
  journal.lastVerification = {
    at: new Date().toISOString(),
    primaryCatalogs: 10,
    primaryWorks: 10,
    frozenMedia: 25,
    added: counters,
  };
  saveJournal();
  console.log(
    JSON.stringify({
      phase4SyntheticSeed: "VERIFIED",
      ...journal.lastVerification,
    }),
  );
}
try {
  await main();
} catch (error) {
  // Driver/Payload errors can contain credentials or arbitrary record data.
  // Retain only an explicit local category and the nonsecret journal step.
  const category =
    error instanceof Error && /^[A-Z_]{3,100}$/.test(error.message)
      ? error.message
      : "SEED_OPERATION_FAILED";
  console.log(
    JSON.stringify({ phase4SyntheticSeed: "FAILED", step, category }),
  );
  process.exitCode = 1;
} finally {
  await payload?.destroy().catch(() => {});
  await pool?.end().catch(() => {});
  await ownerDb?.end().catch(() => {});
}
