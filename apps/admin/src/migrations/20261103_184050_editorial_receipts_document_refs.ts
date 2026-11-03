import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10). A receipt can name the
// Article or collection it wrote, so a replay can return that document. A receipt
// written before this stays with both columns null.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "editorial_receipts" ADD COLUMN "article_id" integer;
  ALTER TABLE "editorial_receipts" ADD COLUMN "article_collection_id" integer;
  ALTER TABLE "editorial_receipts" ADD CONSTRAINT "editorial_receipts_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "editorial_receipts" ADD CONSTRAINT "editorial_receipts_article_collection_id_article_collections_id_fk" FOREIGN KEY ("article_collection_id") REFERENCES "public"."article_collections"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "editorial_receipts_article_idx" ON "editorial_receipts" USING btree ("article_id");
  CREATE INDEX "editorial_receipts_article_collection_idx" ON "editorial_receipts" USING btree ("article_collection_id");`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "editorial_receipts" DROP CONSTRAINT "editorial_receipts_article_id_articles_id_fk";
  
  ALTER TABLE "editorial_receipts" DROP CONSTRAINT "editorial_receipts_article_collection_id_article_collections_id_fk";
  
  DROP INDEX "editorial_receipts_article_idx";
  DROP INDEX "editorial_receipts_article_collection_idx";
  ALTER TABLE "editorial_receipts" DROP COLUMN "article_id";
  ALTER TABLE "editorial_receipts" DROP COLUMN "article_collection_id";`);
}
