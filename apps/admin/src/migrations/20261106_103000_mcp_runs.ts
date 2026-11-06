import {
  sql,
  type MigrateDownArgs,
  type MigrateUpArgs,
} from "@payloadcms/db-postgres";

// admin-mcp-completion-v1 (amendment 2026-11-03, section 10; record section 8). The
// run ledger behind admin_preview and the execute tools: references, versions, frozen
// input and outcomes, never a second business system. No Payload collection and no
// snapshot. infra/development/grant-cms-runtime.sql grants the runtime SELECT, INSERT
// and UPDATE only; the triggers are the second net, for every role, the table owner
// included. Plain SQL with nothing interpolated, so the release tool can take it out of
// this file as it stands (tests/unit/architecture/cms-migration-extractable.test.ts).
//
// mcp_runs: identity never changes; class only rises, and only while planning; a seal
// is written once, when the stored count is the targets' and the expected one; a
// confirmation is written once, from awaiting_owner, to the sealed hash, by an Owner
// row, and nothing else leaves awaiting_owner but a cancel or an expiry; a terminal
// state stays. A run is inserted unsealed and unconfirmed. mcp_run_targets: a target
// joins only an unsealed run; it never moves; its stamp is written once, before the
// seal, with any filling of its input; past that its input may only be cleared. Both
// target checks share the run row, so a seal waits for them and they wait for a seal.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  CREATE TABLE "mcp_runs" (
    "run_id" uuid PRIMARY KEY,
    "format_version" smallint NOT NULL CHECK ("format_version" > 0),
    "contract_version" varchar NOT NULL,
    "op_schema_hash" char(64) NOT NULL CHECK ("op_schema_hash" ~ '^[a-f0-9]{64}$'),
    "credential" varchar NOT NULL CHECK ("credential" ~ '^(key:[1-9][0-9]*|conn:[A-Za-z0-9_-]{1,80})$'),
    "key_id" integer CHECK ("key_id" > 0),
    "connection_id" varchar,
    "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
    "op" varchar NOT NULL,
    "class" varchar NOT NULL CHECK ("class" IN ('read', 'reversible', 'irreversible')),
    "request_id" varchar,
    "fingerprint" char(64) NOT NULL CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
    "reason" text CHECK (char_length("reason") <= 2000),
    "common_input" jsonb CHECK (jsonb_typeof("common_input") = 'object'),
    "selection" jsonb NOT NULL CHECK (jsonb_typeof("selection") = 'object'),
    "planning_cursor" varchar,
    "expected_count" integer CHECK ("expected_count" > 0),
    "target_count" integer NOT NULL DEFAULT 0 CHECK ("target_count" >= 0),
    "sealed_at" timestamptz,
    "seal_hash" char(64) CHECK ("seal_hash" ~ '^[a-f0-9]{64}$'),
    "preview" jsonb CHECK (octet_length("preview"::text) <= 16384),
    "impact" jsonb CHECK (jsonb_typeof("impact") = 'object'),
    "state" varchar NOT NULL CHECK ("state" IN ('previewed', 'planning', 'awaiting_owner', 'confirmed',
      'running', 'settling', 'succeeded', 'partial', 'failed', 'cancelled', 'expired')),
    "next_index" integer NOT NULL DEFAULT 0 CHECK ("next_index" >= 0),
    "counts" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("counts") = 'object'),
    "last_chunk_seq" integer NOT NULL DEFAULT 0 CHECK ("last_chunk_seq" >= 0),
    "last_chunk_hash" char(64) CHECK ("last_chunk_hash" ~ '^[a-f0-9]{64}$'),
    "lease_owner" uuid,
    "lease_expires_at" timestamptz,
    "expires_at" timestamptz NOT NULL,
    "confirmed_by" integer REFERENCES "users"("id") ON DELETE RESTRICT,
    "confirmed_at" timestamptz,
    "confirmed_seal_hash" char(64),
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CHECK (("key_id" IS NULL) <> ("connection_id" IS NULL)),
    CHECK ("credential" = CASE WHEN "key_id" IS NULL THEN 'conn:' || "connection_id" ELSE 'key:' || "key_id" END),
    CHECK ("class" = 'read' OR "request_id" IS NOT NULL),
    CHECK (("sealed_at" IS NULL) = ("seal_hash" IS NULL)),
    CHECK (("confirmed_by" IS NULL) = ("confirmed_at" IS NULL)
      AND ("confirmed_at" IS NULL) = ("confirmed_seal_hash" IS NULL)),
    CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
    CHECK ("state" <> 'planning' OR "sealed_at" IS NULL),
    CHECK ("state" NOT IN ('previewed', 'awaiting_owner', 'confirmed', 'running', 'settling',
      'succeeded', 'partial', 'failed') OR "class" = 'read' OR "sealed_at" IS NOT NULL),
    CHECK ("state" <> 'confirmed' OR "confirmed_at" IS NOT NULL)
  );
  CREATE UNIQUE INDEX "mcp_runs_request" ON "mcp_runs" ("credential", "request_id");
  CREATE INDEX "mcp_runs_by_credential" ON "mcp_runs" ("credential", "created_at" DESC, "run_id");
  CREATE INDEX "mcp_runs_by_expiry" ON "mcp_runs" ("state", "expires_at");
  CREATE INDEX "mcp_runs_by_lease" ON "mcp_runs" ("state", "lease_expires_at")
    WHERE "state" IN ('planning', 'running', 'settling');
  CREATE TABLE "mcp_run_targets" (
    "run_id" uuid NOT NULL REFERENCES "mcp_runs"("run_id") ON DELETE RESTRICT,
    "idx" integer NOT NULL CHECK ("idx" >= 0),
    "ref" jsonb NOT NULL,
    "ref_key" varchar NOT NULL,
    "frozen_input" jsonb CHECK (jsonb_typeof("frozen_input") = 'object'),
    "stamp" varchar,
    "state" varchar NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'conflict', 'applied',
      'already_applied', 'queued', 'failed', 'unknown', 'cancelled')),
    "code" varchar,
    "result" jsonb,
    "attempted_at" timestamptz,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "mcp_run_targets_pkey" PRIMARY KEY ("run_id", "idx"),
    CONSTRAINT "mcp_run_targets_ref_key" UNIQUE ("run_id", "ref_key")
  );
  CREATE FUNCTION "public"."mcp_runs_guard_insert"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."sealed_at" IS NOT NULL OR NEW."confirmed_at" IS NOT NULL
        OR NEW."state" NOT IN ('planning', 'previewed') THEN
        RAISE EXCEPTION 'MCP_RUN_INSERT_UNSEALED' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
  CREATE FUNCTION "public"."mcp_runs_guard"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."run_id" IS DISTINCT FROM OLD."run_id"
        OR NEW."format_version" IS DISTINCT FROM OLD."format_version"
        OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version"
        OR NEW."op_schema_hash" IS DISTINCT FROM OLD."op_schema_hash"
        OR NEW."credential" IS DISTINCT FROM OLD."credential"
        OR NEW."key_id" IS DISTINCT FROM OLD."key_id"
        OR NEW."connection_id" IS DISTINCT FROM OLD."connection_id"
        OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
        OR NEW."op" IS DISTINCT FROM OLD."op"
        OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
        OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
        OR NEW."reason" IS DISTINCT FROM OLD."reason"
        OR NEW."expected_count" IS DISTINCT FROM OLD."expected_count"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'MCP_RUN_IDENTITY_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      IF NEW."common_input" IS DISTINCT FROM OLD."common_input" AND NEW."common_input" IS NOT NULL THEN
        RAISE EXCEPTION 'MCP_RUN_INPUT_FROZEN' USING ERRCODE = '23514';
      END IF;
      IF NEW."class" <> OLD."class" AND NOT (OLD."class" = 'reversible'
        AND NEW."class" = 'irreversible' AND OLD."sealed_at" IS NULL) THEN
        RAISE EXCEPTION 'MCP_RUN_CLASS_RISES_ONLY' USING ERRCODE = '23514';
      END IF;
      IF OLD."state" IN ('succeeded', 'partial', 'failed', 'cancelled', 'expired')
        AND NEW."state" <> OLD."state" THEN
        RAISE EXCEPTION 'MCP_RUN_TERMINAL' USING ERRCODE = '23514';
      END IF;
      IF OLD."sealed_at" IS NOT NULL THEN
        IF NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
          OR NEW."seal_hash" IS DISTINCT FROM OLD."seal_hash"
          OR NEW."target_count" <> OLD."target_count" THEN
          RAISE EXCEPTION 'MCP_RUN_SEALED' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW."sealed_at" IS NOT NULL THEN
        IF NEW."target_count" <> (SELECT count(*) FROM "public"."mcp_run_targets" WHERE "run_id" = NEW."run_id")
          OR NEW."target_count" IS DISTINCT FROM coalesce(NEW."expected_count", NEW."target_count") THEN
          RAISE EXCEPTION 'MCP_RUN_SEAL_COUNT' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF OLD."confirmed_at" IS NOT NULL THEN
        IF NEW."confirmed_by" IS DISTINCT FROM OLD."confirmed_by"
          OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
          OR NEW."confirmed_seal_hash" IS DISTINCT FROM OLD."confirmed_seal_hash" THEN
          RAISE EXCEPTION 'MCP_RUN_CONFIRMED' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW."confirmed_at" IS NOT NULL THEN
        IF OLD."state" <> 'awaiting_owner' OR NEW."state" <> 'confirmed'
          OR NEW."confirmed_seal_hash" IS DISTINCT FROM OLD."seal_hash"
          OR NOT EXISTS (SELECT 1 FROM "public"."users"
            WHERE "id" = NEW."confirmed_by" AND "role" = 'owner') THEN
          RAISE EXCEPTION 'MCP_RUN_CONFIRMATION_INVALID' USING ERRCODE = '23514';
        END IF;
      END IF;
      IF OLD."state" = 'awaiting_owner'
        AND NEW."state" NOT IN ('awaiting_owner', 'confirmed', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'MCP_RUN_AWAITS_OWNER' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
  CREATE FUNCTION "public"."mcp_run_targets_guard_insert"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE sealed timestamptz;
    BEGIN
      SELECT "sealed_at" INTO sealed FROM "public"."mcp_runs"
        WHERE "run_id" = NEW."run_id" FOR SHARE;
      IF sealed IS NOT NULL THEN
        RAISE EXCEPTION 'MCP_RUN_SEALED' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
  CREATE FUNCTION "public"."mcp_run_targets_guard"() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE sealed timestamptz;
    BEGIN
      IF NEW."run_id" IS DISTINCT FROM OLD."run_id" OR NEW."idx" IS DISTINCT FROM OLD."idx"
        OR NEW."ref" IS DISTINCT FROM OLD."ref" OR NEW."ref_key" IS DISTINCT FROM OLD."ref_key" THEN
        RAISE EXCEPTION 'MCP_RUN_TARGET_IMMUTABLE' USING ERRCODE = '23514';
      END IF;
      IF NEW."stamp" IS DISTINCT FROM OLD."stamp" THEN
        SELECT "sealed_at" INTO sealed FROM "public"."mcp_runs"
          WHERE "run_id" = NEW."run_id" FOR SHARE;
        IF OLD."stamp" IS NOT NULL OR sealed IS NOT NULL THEN
          RAISE EXCEPTION 'MCP_RUN_TARGET_STAMPED' USING ERRCODE = '23514';
        END IF;
      ELSIF NEW."frozen_input" IS DISTINCT FROM OLD."frozen_input" AND NEW."frozen_input" IS NOT NULL THEN
        RAISE EXCEPTION 'MCP_RUN_TARGET_FROZEN' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
  REVOKE ALL ON FUNCTION "public"."mcp_runs_guard_insert"() FROM PUBLIC;
  REVOKE ALL ON FUNCTION "public"."mcp_runs_guard"() FROM PUBLIC;
  REVOKE ALL ON FUNCTION "public"."mcp_run_targets_guard_insert"() FROM PUBLIC;
  REVOKE ALL ON FUNCTION "public"."mcp_run_targets_guard"() FROM PUBLIC;
  CREATE TRIGGER "mcp_runs_guard_insert" BEFORE INSERT ON "mcp_runs"
    FOR EACH ROW EXECUTE FUNCTION "public"."mcp_runs_guard_insert"();
  CREATE TRIGGER "mcp_runs_guard" BEFORE UPDATE ON "mcp_runs"
    FOR EACH ROW EXECUTE FUNCTION "public"."mcp_runs_guard"();
  CREATE TRIGGER "mcp_run_targets_guard_insert" BEFORE INSERT ON "mcp_run_targets"
    FOR EACH ROW EXECUTE FUNCTION "public"."mcp_run_targets_guard_insert"();
  CREATE TRIGGER "mcp_run_targets_guard" BEFORE UPDATE ON "mcp_run_targets"
    FOR EACH ROW EXECUTE FUNCTION "public"."mcp_run_targets_guard"();`);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP TABLE "mcp_run_targets";
  DROP TABLE "mcp_runs";
  DROP FUNCTION "public"."mcp_run_targets_guard"();
  DROP FUNCTION "public"."mcp_run_targets_guard_insert"();
  DROP FUNCTION "public"."mcp_runs_guard"();
  DROP FUNCTION "public"."mcp_runs_guard_insert"();`);
}
