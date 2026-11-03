import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10). Alone in its
// migration: PostgreSQL cannot use a new enum value in the transaction that adds
// it, and Payload runs each migration in its own transaction.
//
// Rollback fails on the cast while any row still holds ai_operator, and the
// transaction leaves everything in place; rebind or remove those rows first.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_users_role" ADD VALUE 'ai_operator';`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;
  ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'automation'::text;
  DROP TYPE "public"."enum_users_role";
  CREATE TYPE "public"."enum_users_role" AS ENUM('owner', 'automation');
  ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'automation'::"public"."enum_users_role";
  ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."enum_users_role" USING "role"::"public"."enum_users_role";`);
}
