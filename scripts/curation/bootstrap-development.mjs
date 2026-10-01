import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";
import path from "node:path";
import { pathToFileURL, URL } from "node:url";
import {
  atomicPrivateJSON,
  privateJSON,
  validatePublicationPackage,
} from "./adapter.mjs";

const fail = (code) => {
  throw new Error(code);
};
let payload;
try {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.CMS_ENVIRONMENT !== "synthetic" ||
    process.env.CMS_STORAGE_MODE !== "local" ||
    process.env.ARTVENN_CURATION_BOOTSTRAP !== "fresh-owned-synthetic"
  )
    fail("SYNTHETIC_BOOTSTRAP_REQUIRED");
  const repoRoot = process.env.ARTVENN_CURATION_REPO_ROOT;
  const configFile = process.env.ARTVENN_CURATION_CONFIG_FILE;
  const packageFile = process.env.ARTVENN_CURATION_PACKAGE_FILE;
  const origin = new URL(process.env.CMS_PUBLIC_URL);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port
  )
    fail("SYNTHETIC_LOOPBACK_REQUIRED");
  const guards = await import(
    pathToFileURL(path.join(repoRoot, "scripts/editorial/verify-cms.mjs")).href
  );
  guards.syntheticDatabase(process.env.CMS_DATABASE_URL);
  await guards.verifyLoopbackDisposableTarget(process.env);
  const prepared = await validatePublicationPackage(
    await privateJSON(packageFile),
    { repoRoot, packageDirectory: path.dirname(packageFile) },
  );
  const { getPayload, createLocalReq } = await import(
    pathToFileURL(
      path.join(repoRoot, "apps/admin/node_modules/payload/dist/index.js"),
    ).href
  );
  const config = (
    await import(
      pathToFileURL(path.join(repoRoot, "apps/admin/payload.config.ts")).href
    )
  ).default;
  payload = await getPayload({ config });
  const before = await payload.count({
    collection: "users",
    overrideAccess: true,
  });
  if (before.totalDocs !== 0) fail("BOOTSTRAP_TARGET_NOT_FRESH");
  const owner = await payload.create({
    collection: "users",
    overrideAccess: true,
    data: {
      email: `synthetic-owner-${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString("hex"),
      role: "owner",
    },
  });
  const apiKey = randomBytes(48).toString("hex");
  const catalogIds = prepared.objects.map((object) => object.catalogId);
  const req = await createLocalReq({ user: owner }, payload);
  const automation = await payload.create({
    collection: "users",
    overrideAccess: false,
    req,
    user: owner,
    data: {
      email: `synthetic-curation-${randomUUID()}@example.invalid`,
      password: randomBytes(32).toString("hex"),
      role: "automation",
      scopeCatalogIds: catalogIds,
      enableAPIKey: true,
      apiKey,
    },
  });
  if (
    automation.role !== "automation" ||
    automation.scopeCatalogIds?.length !== catalogIds.length
  )
    fail("AUTOMATION_SCOPE_NOT_CREATED");
  // The bootstrap Owner credentials are neither stored nor returned. No Owner
  // approval or publication operation is called anywhere in this harness.
  await atomicPrivateJSON(configFile, {
    version: 1,
    instance: "development",
    syntheticOnly: true,
    targetVerified: true,
    baseURL: origin.origin,
    apiKey,
    catalogIds,
    databaseName: new URL(process.env.CMS_DATABASE_URL).pathname.slice(1),
  });
  process.stdout.write(
    `${JSON.stringify({ developmentBootstrap: "PASS", automationScopes: catalogIds.length, ownerApproval: "NOT_RUN", publication: "NOT_RUN" })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ developmentBootstrap: "FAIL", category: /^[A-Z_]{3,64}$/u.test(error.message) ? error.message : "SYNTHETIC_BOOTSTRAP_FAILED" })}\n`,
  );
  process.exitCode = 1;
} finally {
  if (payload) await payload.destroy();
}
if (process.exitCode) process.exit(process.exitCode);
