-- Run only after local community migrations. The App role is DML-only on the
-- community namespace: no DDL, no Catalog or CMS relation, no default privilege.
-- Mission 2A/2B bootstrap for the local compose container only. Phase 4 and
-- work publishing narrow and extend this set in
-- infra/development/work-publishing/grant-runtime.sql, which `pnpm dev:migrate`
-- applies right after this file and which revokes the table-level UPDATEs
-- granted below before granting its column lists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yoyi_dev_app') THEN
    -- Existing local volumes predate this role; init-roles.sql covers new ones.
    CREATE ROLE yoyi_dev_app LOGIN PASSWORD 'synthetic-local-app-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
GRANT CONNECT ON DATABASE yoyi_dev TO yoyi_dev_app;
GRANT USAGE ON SCHEMA community TO yoyi_dev_app;
GRANT SELECT ON TABLE
  community.public_users,
  community.development_accounts
TO yoyi_dev_app;
GRANT SELECT, INSERT, UPDATE ON TABLE community.sessions TO yoyi_dev_app;
-- Suspension flips only the account status; handles and ids stay immutable.
GRANT UPDATE (status, updated_at) ON TABLE community.public_users
TO yoyi_dev_app;
-- The Backend is the sole writer of comments and moderation state. Nothing is
-- deleted, so no DELETE is granted anywhere in the namespace.
GRANT SELECT, INSERT, UPDATE ON TABLE
  community.catalog_comments,
  community.catalog_comment_replies
TO yoyi_dev_app;
GRANT SELECT, UPDATE ON TABLE community.publication_setting TO yoyi_dev_app;
-- The moderation audit is append-only for the runtime role.
GRANT SELECT, INSERT ON TABLE community.moderation_events TO yoyi_dev_app;
-- Startup readiness verifies the community ledger read-only.
GRANT SELECT ON TABLE community.schema_migrations TO yoyi_dev_app;

-- Named private Catalog prepare state. This is still the shared App runtime,
-- not a newly isolated worker role. Full manifests and rendition identities are
-- insert-only; only observed lifecycle and the exact public-generation pin may
-- advance. No DELETE/default privilege or CMS relation is granted here.
GRANT SELECT, INSERT ON TABLE
  community.catalog_delivery_prepares,
  community.catalog_delivery_media_refs,
  community.catalog_delivery_rendition_pins
TO yoyi_dev_app;
GRANT UPDATE (source_state, source_state_version, observed_at, observed_live, ended_at, updated_at)
  ON community.catalog_delivery_prepares TO yoyi_dev_app;
GRANT UPDATE (public_generation_id, public_generation_version)
  ON community.catalog_delivery_rendition_pins TO yoyi_dev_app;

GRANT SELECT, INSERT ON community.catalog_delivery_snapshot_watermark TO yoyi_dev_app;
GRANT UPDATE(observed_at) ON community.catalog_delivery_snapshot_watermark TO yoyi_dev_app;
