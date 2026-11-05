import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-05, section 5). The audit names the
// connection and the person who authorized it, and every operator connection acts
// as one `users` row, named by ADMIN_MCP_OPERATOR_ROW_EMAIL in packages/contracts.
// The row has no salt or hash, so nobody can sign in with it, and the role refuses
// a login and a REST key anyway. A row already holding that address stays as it is,
// and the door then refuses unless its role is ai_operator.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "mcp_audit_events" ADD COLUMN "connection_id" varchar;
  ALTER TABLE "mcp_audit_events" ADD COLUMN "authorized_by" varchar;
  INSERT INTO "users" ("role", "email") VALUES ('ai_operator', 'ai-connection@operator.invalid') ON CONFLICT ("email") DO NOTHING;`);
}

// The row stays: a lock or receipt may name it, and `up` tolerates it. So a rollback
// of the chain past 20261103_143652_ai_operator_role fails that migration's cast on
// this row, and needs this first, by hand, since `users` refuses a delete over REST:
//   DELETE FROM "users" WHERE "email" = 'ai-connection@operator.invalid' AND "role" = 'ai_operator';
export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "mcp_audit_events" DROP COLUMN "connection_id";
  ALTER TABLE "mcp_audit_events" DROP COLUMN "authorized_by";`);
}
