import { fileURLToPath } from "node:url";

import { CommunityStoreUnavailableError } from "@moya/api";
import {
  CommunitySchemaNotReadyError,
  readCommunityMigrationFiles,
  requiredCommunityMigrations,
  verifyCommunityMigrationLedger,
} from "@moya/community-postgres";
import { describe, expect, it, vi } from "vitest";

type LedgerPool = Parameters<typeof verifyCommunityMigrationLedger>[0];

const poolWith = (query: (sql: string) => Promise<unknown>) => {
  const release = vi.fn();
  return {
    pool: {
      connect: async () => ({ query, release }),
    } as unknown as LedgerPool,
    release,
  };
};

const pgError = (code: string) => Object.assign(new Error(code), { code });

describe("community migration family", () => {
  it("pins the checked-in SQL files to the manifest checksums", async () => {
    const files = await readCommunityMigrationFiles(
      fileURLToPath(
        new URL("../../../database/community-migrations", import.meta.url),
      ),
    );
    expect(
      files.map(({ migrationId, filename, checksum }) => ({
        migrationId,
        filename,
        checksum,
      })),
    ).toEqual(requiredCommunityMigrations);
    // Append-only: implemented Community features and release corrections.
    expect(requiredCommunityMigrations.map(({ filename }) => filename)).toEqual(
      [
        "20260912030000_community_identity_sessions.sql",
        "20260912050000_community_comments_moderation.sql",
        "20260912080000_community_direct_publication_default.sql",
        "20260912100000_community_moderation_reject_and_history.sql",
        "20260913090000_author_community_foundations.sql",
        "20260913100000_discussion_lifecycle.sql",
        "20260913110000_discovery_sequences.sql",
        "20260913120000_featured_operator_versions.sql",
        "20260914090000_work_publishing_storage.sql",
        "20260914091000_work_publishing_revisions.sql",
        "20260914092000_work_publishing_legacy_backfill.sql",
        "20260914093000_work_publishing_legacy_bridge.sql",
        "20260914094000_work_publishing_legacy_authorship.sql",
        "20260915010000_featured_users.sql",
        "20260916010000_community_access_indexes.sql",
        "20260916011000_receipt_timestamps.sql",
        "20260917010000_agent_administration.sql",
        "20260917020000_agent_operation_criteria.sql",
        "20260918010000_agent_connections.sql",
        "20260918020000_agent_connection_provider_artifacts.sql",
        "20260918030000_agent_connection_invariants.sql",
        "20260918040000_agent_connection_ledger_integrity.sql",
        "20260918050000_agent_connection_destroyed_at_terminal.sql",
        "20260920010000_agent_connection_principal_identity.sql",
        "20260920020000_profile_background_and_permanent_media.sql",
        "20260920050000_agent_connection_consent.sql",
        "20260920060000_agent_connection_identity_frozen.sql",
        "20260920070000_agent_connection_identity_reason.sql",
        "20260920080000_agent_connection_client_slug.sql",
        "20260921010000_agent_connection_one_per_client.sql",
        "20260922010000_email_phone_login_identities.sql",
        "20260922011000_auth_failure_rows_and_receipt_seal.sql",
        "20260922020000_notification_foundation.sql",
        "20260922030000_threads.sql",
        "20260922031000_article_discussion_target.sql",
        "20260922032000_direct_messages.sql",
        "20260930010000_password_credentials_and_studio.sql",
        "20260930020000_article_authoring.sql",
        "20260930030000_article_authoring_delegation.sql",
        "20260930040000_article_consent_uid_check.sql",
        "20261001010000_profile_studio_name_suffix.sql",
        "20261001020000_article_draft_deletion.sql",
        "20261002010000_login_lookup_version_rotation.sql",
        "20261002020000_article_connection_environments.sql",
      ],
    );
    expect(files.every((file) => file.sql.includes("community."))).toBe(true);
    expect(files.some((file) => /CREATE SCHEMA/i.test(file.sql))).toBe(false);
  });

  it("verifies the ledger read-only and releases the client", async () => {
    const statements: string[] = [];
    const { pool, release } = poolWith(async (sql) => {
      statements.push(sql);
      return {
        rows: requiredCommunityMigrations.map(
          ({ migrationId, filename, checksum }) => ({
            migration_id: migrationId,
            filename,
            checksum,
          }),
        ),
      };
    });
    await expect(verifyCommunityMigrationLedger(pool)).resolves.toBeUndefined();
    expect(statements).toHaveLength(1);
    expect(statements.join("\n")).not.toMatch(
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["42P01", "3F000", "42501"])(
    "fails closed as schema-not-ready when the ledger is missing or ungranted (%s)",
    async (code) => {
      const { pool, release } = poolWith(async () => {
        throw pgError(code);
      });
      await expect(verifyCommunityMigrationLedger(pool)).rejects.toBeInstanceOf(
        CommunitySchemaNotReadyError,
      );
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("reports a changed applied migration and connection loss distinctly", async () => {
    const { pool: tampered } = poolWith(async () => ({
      rows: requiredCommunityMigrations.map(({ migrationId, filename }) => ({
        migration_id: migrationId,
        filename,
        checksum: "0".repeat(64),
      })),
    }));
    await expect(verifyCommunityMigrationLedger(tampered)).rejects.toThrow(
      "immutable",
    );
    const { pool: down } = poolWith(async () => {
      throw pgError("57P01");
    });
    await expect(verifyCommunityMigrationLedger(down)).rejects.toBeInstanceOf(
      CommunityStoreUnavailableError,
    );
  });
});
