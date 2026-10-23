import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

import {
  downgradeCatalogDeliveryPrepareViewsSql,
  upgradeCatalogDeliveryPrepareViewsSql,
} from "../published/views";

// catalog-scale-v1 (M2): catalog_delivery_prepare_media becomes a
// security_barrier view without the OFFSET 0 fence (same rows, columns and
// grant), and catalog_delivery_live_prepare_media holds the intents the
// worker's complete snapshot reads: every released intent and every other one
// that ended or expired within R (96 hours), found through a new index on
// catalog_delivery_intents (state, ended_at) instead of a scan of every intent
// ever prepared. No reader is granted the new view here; re-run
// infra/development/catalog-media/grant-prepare-read.sql after this migration
// and before deploying a worker or Backend that reads it. With a prepare
// database configured, their startup checks that grant and refuses without
// it. #320's worker and Backend read only the old view, whose rows are
// unchanged. Each statement set begins with SET LOCAL lock_timeout, which
// ends with Payload's per-migration transaction; a 55P03 failure leaves
// nothing behind and the migration is simply re-run.
//
// Rollback: undo M2 alone with `payload migrate:down` only while it is a batch
// of its own; otherwise run downgradeCatalogDeliveryPrepareViewsSql and delete
// its payload_migrations row in one transaction, as for M1.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql.raw(upgradeCatalogDeliveryPrepareViewsSql));
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql.raw(downgradeCatalogDeliveryPrepareViewsSql));
}
