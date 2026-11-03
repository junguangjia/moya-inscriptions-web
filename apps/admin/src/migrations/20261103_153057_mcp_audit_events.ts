import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10). The AI audit ledger.
// infra/development/grant-cms-runtime.sql grants the runtime SELECT and INSERT
// only; the trigger is the second net, for every role, the table owner included.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_mcp_audit_events_phase" AS ENUM('start', 'finish');
  CREATE TYPE "public"."enum_mcp_audit_events_class" AS ENUM('read', 'reversible', 'irreversible', 'write', 'reserved');
  CREATE TABLE "mcp_audit_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"at" timestamp(3) with time zone NOT NULL,
  	"phase" "enum_mcp_audit_events_phase" NOT NULL,
  	"class" "enum_mcp_audit_events_class" NOT NULL,
  	"tool" varchar,
  	"op" varchar,
  	"ok" boolean,
  	"code" varchar,
  	"key_label" varchar,
  	"target_type" varchar,
  	"target_id" varchar,
  	"count" numeric,
  	"changed_fields" jsonb,
  	"call_id" varchar NOT NULL,
  	"key_id" numeric,
  	"user_id" varchar,
  	"run_id" varchar,
  	"request_id" varchar,
  	"duration_ms" numeric,
  	"response_bytes" numeric,
  	"db_ms" numeric,
  	"upstream_ms" numeric,
  	"query_count" numeric,
  	"cache_hit" boolean,
  	"branch_latency" jsonb,
  	"before_hash" varchar,
  	"after_hash" varchar
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "mcp_audit_events_id" integer;
  CREATE INDEX "mcp_audit_events_at_idx" ON "mcp_audit_events" USING btree ("at");
  CREATE INDEX "mcp_audit_events_call_id_idx" ON "mcp_audit_events" USING btree ("call_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_mcp_audit_events_fk" FOREIGN KEY ("mcp_audit_events_id") REFERENCES "public"."mcp_audit_events"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_mcp_audit_events_id_idx" ON "payload_locked_documents_rels" USING btree ("mcp_audit_events_id");
  CREATE FUNCTION "public"."mcp_audit_events_refuse_change"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'MCP_AUDIT_APPEND_ONLY' USING ERRCODE = '42501';
    END;
    $$;
  REVOKE ALL ON FUNCTION "public"."mcp_audit_events_refuse_change"() FROM PUBLIC;
  CREATE TRIGGER "mcp_audit_events_append_only"
    BEFORE UPDATE OR DELETE ON "mcp_audit_events"
    FOR EACH ROW EXECUTE FUNCTION "public"."mcp_audit_events_refuse_change"();`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // The rels column goes first: its foreign key would make the generated order,
  // table first and constraint after, fail on a constraint CASCADE already took.
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_mcp_audit_events_fk";
  DROP INDEX "payload_locked_documents_rels_mcp_audit_events_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "mcp_audit_events_id";
  DROP TABLE "mcp_audit_events" CASCADE;
  DROP FUNCTION "public"."mcp_audit_events_refuse_change"();
  DROP TYPE "public"."enum_mcp_audit_events_phase";
  DROP TYPE "public"."enum_mcp_audit_events_class";`);
}
