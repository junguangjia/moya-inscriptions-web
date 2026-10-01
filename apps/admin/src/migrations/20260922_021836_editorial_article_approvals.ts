import { MigrateUpArgs, MigrateDownArgs, sql } from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_editorial_article_approvals_status" AS ENUM('active', 'revoked');
  CREATE TABLE "editorial_article_approvals_items" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"article_id" integer NOT NULL,
  	"revision" numeric NOT NULL,
  	"fingerprint" varchar
  );
  
  CREATE TABLE "editorial_article_approvals" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"automation_user_id" integer NOT NULL,
  	"status" "enum_editorial_article_approvals_status" DEFAULT 'active' NOT NULL,
  	"approved_by_id" integer,
  	"approved_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "editorial_article_approvals_id" integer;
  ALTER TABLE "editorial_article_approvals_items" ADD CONSTRAINT "editorial_article_approvals_items_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "editorial_article_approvals_items" ADD CONSTRAINT "editorial_article_approvals_items_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."editorial_article_approvals"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "editorial_article_approvals" ADD CONSTRAINT "editorial_article_approvals_automation_user_id_users_id_fk" FOREIGN KEY ("automation_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "editorial_article_approvals" ADD CONSTRAINT "editorial_article_approvals_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "editorial_article_approvals_items_order_idx" ON "editorial_article_approvals_items" USING btree ("_order");
  CREATE INDEX "editorial_article_approvals_items_parent_id_idx" ON "editorial_article_approvals_items" USING btree ("_parent_id");
  CREATE INDEX "editorial_article_approvals_items_article_idx" ON "editorial_article_approvals_items" USING btree ("article_id");
  CREATE INDEX "editorial_article_approvals_automation_user_idx" ON "editorial_article_approvals" USING btree ("automation_user_id");
  CREATE INDEX "editorial_article_approvals_approved_by_idx" ON "editorial_article_approvals" USING btree ("approved_by_id");
  CREATE INDEX "editorial_article_approvals_updated_at_idx" ON "editorial_article_approvals" USING btree ("updated_at");
  CREATE INDEX "editorial_article_approvals_created_at_idx" ON "editorial_article_approvals" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_editorial_article_approvals_fk" FOREIGN KEY ("editorial_article_approvals_id") REFERENCES "public"."editorial_article_approvals"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_editorial_article_approval_idx" ON "payload_locked_documents_rels" USING btree ("editorial_article_approvals_id");`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "editorial_article_approvals_items" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "editorial_article_approvals" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "editorial_article_approvals_items" CASCADE;
  DROP TABLE "editorial_article_approvals" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_editorial_article_approvals_fk";
  
  DROP INDEX "payload_locked_documents_rels_editorial_article_approval_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "editorial_article_approvals_id";
  DROP TYPE "public"."enum_editorial_article_approvals_status";`);
}
