import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { getPayload, createLocalReq } from "payload";
import config from "../payload.config";
if (process.env.CMS_ENVIRONMENT !== "synthetic")
  throw new Error("SYNTHETIC_ENVIRONMENT_REQUIRED");
// The synthetic Owner is the one bootstrap-synthetic.ts handed over for this
// session; its address is namespaced per session, never a fixed value.
const handoff = process.env.CMS_QA_HANDOFF_FILE;
if (!handoff) throw new Error("SYNTHETIC_HANDOFF_REQUIRED");
const settings = JSON.parse(await readFile(handoff, "utf8")) as {
  ownerEmail: string;
  ownerId: number;
};
const payload = await getPayload({ config });
const started = performance.now();
const prefix = `catalog-scale-${randomUUID()}`;
const owner = (
  await payload.find({
    collection: "users",
    where: { email: { equals: settings.ownerEmail } },
    limit: 1,
  })
).docs[0];
if (!owner || owner.id !== settings.ownerId)
  throw new Error("SYNTHETIC_BOOTSTRAP_REQUIRED");
let created = 0;
try {
  const before = await payload.db.pool.query<{ bytes: string }>(
    "SELECT pg_database_size(current_database())::text AS bytes",
  );
  const results = [];
  for (const target of [100, 1000, 10000]) {
    const stageStarted = performance.now();
    while (created < target) {
      if (
        performance.now() - started > 180000 ||
        process.memoryUsage().rss > 1400 * 1024 * 1024
      )
        throw new Error("SYNTHETIC_RESOURCE_LIMIT");
      const chunk = Math.min(4, target - created);
      await Promise.all(
        Array.from({ length: chunk }, async (_, offset) => {
          const n = created + offset;
          const req = await createLocalReq(
            { user: { ...owner, collection: "users" } },
            payload,
          );
          await payload.create({
            collection: "catalogs",
            overrideAccess: false,
            req,
            user: req.user,
            draft: true,
            data: {
              catalogId: `${prefix}-${String(n).padStart(5, "0")}`,
              sourceId: `source-scale-${prefix}-${n}`,
              kind: "inscription",
              title: `合成分页资料 ${n}`,
              _status: "draft",
              revision: 0,
            },
          });
        }),
      );
      created += chunk;
    }
    const queryStarted = performance.now();
    const page = await payload.find({
      collection: "catalogs",
      user: { ...owner, collection: "users" },
      overrideAccess: false,
      draft: true,
      depth: 0,
      limit: 25,
      page: Math.ceil(target / 25),
      where: { catalogId: { contains: prefix } },
      sort: "catalogId",
    });
    if (page.totalDocs !== target || page.docs.length !== 25)
      throw new Error("SYNTHETIC_PAGINATION_MISMATCH");
    results.push({
      records: target,
      stageMs: Math.round(performance.now() - stageStarted),
      lastPageQueryMs: Math.round(performance.now() - queryStarted),
      poolConnections: payload.db.pool.totalCount,
    });
    console.log(JSON.stringify({ syntheticScale: results.at(-1) }));
  }
  const after = await payload.db.pool.query<{ bytes: string }>(
    "SELECT pg_database_size(current_database())::text AS bytes",
  );
  console.log(
    JSON.stringify({
      syntheticScaleCompleted: true,
      results,
      elapsedMs: Math.round(performance.now() - started),
      maximumResidentKiB: process.resourceUsage().maxRSS,
      databaseGrowthBytes:
        Number(after.rows[0]!.bytes) - Number(before.rows[0]!.bytes),
      concurrentWrites: 4,
      publicConcurrentUsers: "not_measured",
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      syntheticScaleCompleted: false,
      created,
      category:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "SYNTHETIC_BENCHMARK_FAILED",
      maximumResidentKiB: process.resourceUsage().maxRSS,
    }),
  );
  process.exitCode = 1;
} finally {
  await payload.destroy();
}
