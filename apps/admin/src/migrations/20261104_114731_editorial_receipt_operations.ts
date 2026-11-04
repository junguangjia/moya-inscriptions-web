import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10). New values only: no row
// uses them in this transaction, and a receipt written before keeps its value.
//
// Rollback fails on the cast while any row still holds one of them, and the
// transaction leaves everything in place.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'approve-batch';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'approve-article-batch';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'publish-direct';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'withdraw';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'restore-draft';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'patch-text';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'duplicate';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'article-publish';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'article-withdraw';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'article-restore';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'article-duplicate';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'collection-save';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'collection-publish';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'collection-withdraw';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'collection-restore';
  ALTER TYPE "public"."enum_editorial_receipts_operation" ADD VALUE 'collection-duplicate';`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "editorial_receipts" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_editorial_receipts_operation";
  CREATE TYPE "public"."enum_editorial_receipts_operation" AS ENUM('save-draft', 'publish-approved');
  ALTER TABLE "editorial_receipts" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_editorial_receipts_operation" USING "operation"::"public"."enum_editorial_receipts_operation";`);
}
