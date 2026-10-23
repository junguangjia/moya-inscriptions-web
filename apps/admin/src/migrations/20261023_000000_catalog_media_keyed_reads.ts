import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

import {
  downgradePublishedCatalogMediaViewSql,
  upgradePublishedCatalogMediaViewSql,
} from "../published/views";

// catalog-scale-v1 (M1): catalog_media becomes a security_barrier view without
// the OFFSET 0 fence, over a media_id lookup index. Rows, columns and grants
// are unchanged and no code depends on it, so it may run before or after any
// Backend. Each statement set begins with SET LOCAL lock_timeout, which ends
// with Payload's per-migration transaction; a 55P03 failure leaves nothing
// behind and the migration is simply re-run.
//
// Rollback: `payload migrate:down` undoes the whole latest batch, and the down
// of 20261020_160000 drops the delivery intent tables. Apply that migration in
// an earlier `payload migrate` call, so M1 is a batch of its own, or undo M1
// alone by running downgradePublishedCatalogMediaViewSql and deleting its
// payload_migrations row in one transaction.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql.raw(upgradePublishedCatalogMediaViewSql));
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql.raw(downgradePublishedCatalogMediaViewSql));
}
