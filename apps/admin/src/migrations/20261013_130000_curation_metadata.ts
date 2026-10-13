import { MigrateUpArgs, MigrateDownArgs, sql } from "@payloadcms/db-postgres";

/** Add metadata to the already-granted, append-only editorial ledger. */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TYPE "public"."enum_editorial_receipts_operation"
      ADD VALUE IF NOT EXISTS 'save-curation-metadata';
    ALTER TABLE "public"."editorial_receipts"
      ADD COLUMN "metadata_json" varchar,
      ADD COLUMN "metadata_sha256" varchar,
      ADD COLUMN "metadata_catalog_id" varchar,
      ADD COLUMN "previous_metadata_sha256" varchar,
      ADD COLUMN "metadata_version" numeric;

    -- Do not reference the new enum value before its transaction commits.
    -- Existing receipts have NULL metadata and are unaffected by these keys.
    -- These partial indexes are SQL-owned: Payload's schema generator cannot
    -- represent their predicates, so they stay out of its JSON snapshot.
    CREATE UNIQUE INDEX "editorial_receipts_metadata_content_idx"
      ON "public"."editorial_receipts" ("metadata_catalog_id", "metadata_sha256")
      WHERE "metadata_catalog_id" IS NOT NULL AND "metadata_sha256" IS NOT NULL;
    CREATE UNIQUE INDEX "editorial_receipts_metadata_version_idx"
      ON "public"."editorial_receipts" ("metadata_catalog_id", "metadata_version")
      WHERE "metadata_catalog_id" IS NOT NULL AND "metadata_version" IS NOT NULL;
  `);
}

/** Application rollback retains the additive schema and every metadata row. */
export async function down(args: MigrateDownArgs): Promise<void> {
  void args; // All targets retain metadata until an explicit retention plan.
  throw new Error("CURATION_METADATA_DOWN_REQUIRES_EXPLICIT_RETENTION_PLAN");
}
