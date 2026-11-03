import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10). The Owner's control
// global: pause, threshold and four switches, all starting closed. A global has
// no row until its first save, and the door reads a missing row as these defaults.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "mcp_control" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"pause" boolean DEFAULT false,
  	"threshold" numeric DEFAULT 20 NOT NULL,
  	"dm" boolean DEFAULT false,
  	"dm_opened_at" timestamp(3) with time zone,
  	"dm_opened_by_id" integer,
  	"evidence" boolean DEFAULT false,
  	"evidence_opened_at" timestamp(3) with time zone,
  	"evidence_opened_by_id" integer,
  	"raw_ip" boolean DEFAULT false,
  	"raw_ip_opened_at" timestamp(3) with time zone,
  	"raw_ip_opened_by_id" integer,
  	"self_only" boolean DEFAULT false,
  	"self_only_opened_at" timestamp(3) with time zone,
  	"self_only_opened_by_id" integer,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "mcp_control" ADD CONSTRAINT "mcp_control_dm_opened_by_id_users_id_fk" FOREIGN KEY ("dm_opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "mcp_control" ADD CONSTRAINT "mcp_control_evidence_opened_by_id_users_id_fk" FOREIGN KEY ("evidence_opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "mcp_control" ADD CONSTRAINT "mcp_control_raw_ip_opened_by_id_users_id_fk" FOREIGN KEY ("raw_ip_opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "mcp_control" ADD CONSTRAINT "mcp_control_self_only_opened_by_id_users_id_fk" FOREIGN KEY ("self_only_opened_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "mcp_control_dm_opened_by_idx" ON "mcp_control" USING btree ("dm_opened_by_id");
  CREATE INDEX "mcp_control_evidence_opened_by_idx" ON "mcp_control" USING btree ("evidence_opened_by_id");
  CREATE INDEX "mcp_control_raw_ip_opened_by_idx" ON "mcp_control" USING btree ("raw_ip_opened_by_id");
  CREATE INDEX "mcp_control_self_only_opened_by_idx" ON "mcp_control" USING btree ("self_only_opened_by_id");`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "mcp_control" CASCADE;`);
}
