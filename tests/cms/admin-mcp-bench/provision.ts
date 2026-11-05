import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import config from "admin/config";
import { createLocalReq, getPayload } from "payload";

// Run once through `payload run` by run.mjs: the accounts and keys the bench calls
// with, and the synthetic chart it views, through the real collections. The secrets
// are random per run and live only in the session's mode-restricted file.

const destination = process.env.ADMIN_MCP_BENCH_ACCESS_FILE;
const chartFile = process.env.ADMIN_MCP_BENCH_CHART_FILE;
if (process.env.CMS_ENVIRONMENT !== "synthetic" || !destination || !chartFile)
  throw new Error("SYNTHETIC_BENCH_ENVIRONMENT_REQUIRED");

const CHART_MEDIA_ID = "bench-media-chart";

const payload = await getPayload({ config });
try {
  const account = (name: string, role: "owner" | "automation") =>
    payload.create({
      collection: "users",
      overrideAccess: true,
      data: {
        email: `bench-${name}-${randomBytes(6).toString("hex")}@example.invalid`,
        password: randomBytes(24).toString("hex"),
        role,
        scopeCatalogIds: [],
      },
    });
  const owner = await account("owner", "owner");
  const automation = await account("ai", "automation");
  const aiOperator = await payload.update({
    collection: "users",
    id: automation.id,
    overrideAccess: true,
    data: { role: "ai_operator" },
  });
  // Approval batches name an automation account; the AI key publishes them.
  const approvedFor = await account("automation", "automation");
  const secrets: Record<string, string> = {};
  for (const profile of ["read", "full"]) {
    secrets[profile] = randomBytes(32).toString("hex");
    await payload.create({
      collection: "payload-mcp-api-keys",
      overrideAccess: true,
      data: {
        user: aiOperator.id,
        label: `synthetic-bench-${profile}`,
        enableAPIKey: true,
        apiKey: secrets[profile],
        toolProfile: profile,
      } as never,
    });
  }
  const chart = await readFile(chartFile);
  await payload.create({
    collection: "media",
    overrideAccess: false,
    req: await createLocalReq(
      { user: { ...owner, collection: "users" } },
      payload,
    ),
    data: {
      mediaId: CHART_MEDIA_ID,
      catalogId: "bench-catalog-00001",
      alt: "合成高细节测试图",
      origin: "upload",
    } as never,
    file: {
      name: "synthetic-chart.jpg",
      data: chart,
      mimetype: "image/jpeg",
      size: chart.length,
    },
  });
  await writeFile(
    destination,
    JSON.stringify({
      ownerId: owner.id,
      automationId: approvedFor.id,
      secrets,
      chartMediaId: CHART_MEDIA_ID,
    }),
    { mode: 0o600, flag: "wx" },
  );
} finally {
  await payload.destroy();
}
