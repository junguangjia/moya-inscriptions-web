import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10). Every existing key
// starts a 30-day clock at deployment, and the door refuses a null expiry, so a
// row this backfill missed reads as expired. Existing keys take the read profile
// from the column default; the profile applies only to ai_operator keys.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_payload_mcp_api_keys_tool_profile" AS ENUM('read', 'operate', 'full');
  ALTER TABLE "payload_mcp_api_keys" ADD COLUMN "tool_profile" "enum_payload_mcp_api_keys_tool_profile" DEFAULT 'read';
  ALTER TABLE "payload_mcp_api_keys" ADD COLUMN "expires_at" timestamp(3) with time zone;
  ALTER TABLE "payload_mcp_api_keys" ADD COLUMN "last_used_at" timestamp(3) with time zone;
  UPDATE "payload_mcp_api_keys" SET "expires_at" = now() + interval '30 days';`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_mcp_api_keys" DROP COLUMN "tool_profile";
  ALTER TABLE "payload_mcp_api_keys" DROP COLUMN "expires_at";
  ALTER TABLE "payload_mcp_api_keys" DROP COLUMN "last_used_at";
  DROP TYPE "public"."enum_payload_mcp_api_keys_tool_profile";`);
}
