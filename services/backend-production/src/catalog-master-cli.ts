import { closePostgresPool, createPostgresPool } from "@moya/catalog-postgres";
import {
  PostgresCatalogDisplayMasterAdapter,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";

import {
  CatalogMasterUsageError,
  parseCatalogMasterArguments,
  runCatalogMasterCommand,
  runCatalogMasterManifest,
} from "./catalog-master/commands.js";
import { ApprovalDocumentError } from "./catalog-master/approval.js";
import { parseCommunityPostgresConfig } from "./community-postgres-config.js";
import {
  openProductionPublishingStore,
  openPublishingStore,
  parseProductionPublishingStoreConfig,
  parsePublishingStoreDirectory,
} from "./publishing/config.js";

import type { CatalogMasterStore } from "./catalog-master/commands.js";

/*
 * `catalog-master` (catalog-deep-zoom-v1): the Owner's command for private
 * Catalog display masters, run on the server with the media worker's
 * environment (the App role and the UGC store). Each Production run is an
 * Owner "run". `manifest` runs on the Owner's Mac and opens no connection.
 * Output is content-free JSON lines; failures print one generic line,
 * because driver and provider errors can carry private endpoints.
 */

type Environment = Readonly<Record<string, string | undefined>>;

const openStore = async (
  environment: Environment,
): Promise<CatalogMasterStore> => {
  if (environment.NODE_ENV === "production")
    return openProductionPublishingStore(
      parseProductionPublishingStoreConfig(environment),
    );
  const directory = parsePublishingStoreDirectory(environment);
  if (directory === null)
    throw new CatalogMasterUsageError("WORK_MEDIA_STORE_DIR is required");
  return openPublishingStore(directory);
};

const out = (line: Record<string, unknown>) => {
  console.info(JSON.stringify(line));
};

const main = async (): Promise<void> => {
  const parsed = parseCatalogMasterArguments(process.argv.slice(2));
  if (parsed.command === "manifest") {
    if (!(await runCatalogMasterManifest(parsed, out))) process.exitCode = 1;
    return;
  }
  const environment = process.env;
  if (
    environment.NODE_ENV !== "production" &&
    environment.NODE_ENV !== "development"
  )
    throw new CatalogMasterUsageError(
      "NODE_ENV must be production or development",
    );
  const pool = createPostgresPool(parseCommunityPostgresConfig(environment), {
    onUnexpectedIdleError: () => {
      console.error("[catalog-master] unexpected PostgreSQL pool error");
    },
  });
  try {
    await verifyCommunityMigrationLedger(pool);
    let store: Promise<CatalogMasterStore> | undefined;
    const ok = await runCatalogMasterCommand(parsed, {
      port: new PostgresCatalogDisplayMasterAdapter(pool),
      store: () => (store ??= openStore(environment)),
      out,
      now: () => new Date(),
    });
    if (!ok) process.exitCode = 1;
  } finally {
    await closePostgresPool(pool);
  }
};

main().catch((error: unknown) => {
  if (
    error instanceof CatalogMasterUsageError ||
    error instanceof ApprovalDocumentError
  )
    console.error(`[catalog-master] ${error.message}`);
  else
    console.error(
      "[catalog-master] operation stopped; check the environment, the approval document and the inbox",
    );
  process.exitCode = process.exitCode || 2;
});
