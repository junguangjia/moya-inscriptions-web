-- admin-mcp-oauth-grants.sql: what the three login door roles may do in
-- Production (Issue #355, amendment 2026-11-05, section 5).
--
-- Derived from infra/development/agent-connections/grant-authorization.sql, whose
-- comments give the reason for each privilege. This file differs in three ways:
-- it creates no role and holds no password, it names no `agent_principals`
-- privilege because an operator connection provisions no machine principal, and
-- it knows no Backend role.
--
--   provider role  -- the OAuth issuer. Owns the protocol's own storage and mints
--                     tokens. Never sees an Admin session, and cannot record a
--                     consent decision.
--   consent role   -- the Admin control plane. Records decisions and the digest
--                     of the one-time resume secret. Cannot mint a grant or a
--                     token.
--   resource role  -- the Admin's MCP door. May only READ a connection, its grant
--                     and a wrapper, and stamp when a request last authenticated.
--
-- The roles are created first, separately, with their own passwords. None is a
-- superuser, and none is the migration account or a role the Admin or Backend
-- already runs as.
--
-- RUN as the database owner, after the community migrations, on one session,
-- having named all three roles. `current_setting` has no default here on purpose:
-- a missing name raises 42704 rather than granting nothing.
--
--   SELECT set_config('agent_connections.provider_role', '<role>', false);
--   SELECT set_config('agent_connections.consent_role',  '<role>', false);
--   SELECT set_config('agent_connections.resource_role', '<role>', false);
--
-- One plain DO block, so a driver can run it and the committed regression runs
-- this file rather than a re-typed copy. Running it again changes nothing.
DO $$
DECLARE
  provider_role text := current_setting('agent_connections.provider_role');
  consent_role  text := current_setting('agent_connections.consent_role');
  resource_role text := current_setting('agent_connections.resource_role');
BEGIN
  IF provider_role = consent_role
     OR provider_role = resource_role
     OR consent_role = resource_role THEN
    RAISE EXCEPTION 'the provider, consent and resource roles must be distinct; splitting them IS the control';
  END IF;

  IF current_user IN (provider_role, consent_role, resource_role) THEN
    RAISE EXCEPTION 'a login door role must not be the account running this file';
  END IF;

  IF (SELECT count(*) FROM pg_roles
       WHERE rolname IN (provider_role, consent_role, resource_role)) <> 3 THEN
    RAISE EXCEPTION 'create the three login door roles first; this file creates none';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname IN (provider_role, consent_role, resource_role)
                AND (rolsuper OR rolcreatedb OR rolcreaterole
                     OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'a login door role must hold no superuser, createdb, createrole, replication or bypassrls attribute';
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I',
    current_database(), provider_role, consent_role, resource_role);
  EXECUTE format('GRANT USAGE ON SCHEMA community TO %I, %I, %I',
    provider_role, consent_role, resource_role);

  -- ------------------------------------------------------------- provider --
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
       community.agent_connection_provider_artifacts,
       community.agent_connection_wrappers
     TO %I', provider_role);

  -- The immutable consent snapshot. INSERT only, apart from the two destruction
  -- columns: nothing may ever move generation_at_consent.
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE community.agent_connection_grants TO %I',
    provider_role);
  EXECUTE format(
    'GRANT UPDATE (destroy_status, destroyed_at)
       ON TABLE community.agent_connection_grants TO %I', provider_role);

  -- It may point a connection at the grant it just made, and nothing else.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connections TO %I', provider_role);
  EXECUTE format(
    'GRANT UPDATE (current_grant_id) ON TABLE community.agent_connections TO %I',
    provider_role);

  -- It opens the interaction, writing only what it will enforce, and later marks
  -- it spent. The INSERT is a column list because that is the whole control: it
  -- must not be able to write a decision, a human or a digest in the first place,
  -- and the freeze trigger is BEFORE UPDATE. SELECT reads the resume digest, which
  -- is a digest of a secret this role never holds.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connection_consents TO %I',
    provider_role);
  EXECUTE format(
    'GRANT INSERT (interaction_uid, oauth_client_id, resource,
                   capability_scopes, protocol_scopes, preset, expires_at)
       ON TABLE community.agent_connection_consents TO %I', provider_role);
  EXECUTE format(
    'GRANT UPDATE (resumed_at, grant_id)
       ON TABLE community.agent_connection_consents TO %I', provider_role);

  -- The one way it removes a consent row. It holds no DELETE on that table.
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION community.agent_connection_consents_reap(INTEGER) TO %I',
    provider_role);

  EXECUTE format(
    'GRANT SELECT ON TABLE community.schema_migrations TO %I', provider_role);

  -- -------------------------------------------------------------- consent --
  --
  -- It says WHO is deciding and about WHICH connection, then records the decision
  -- with the digest of the secret it handed that browser. It cannot create an
  -- interaction or alter what the provider will enforce.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connection_consents TO %I',
    consent_role);
  EXECUTE format(
    'GRANT UPDATE (ticket_digest, human_account_id, connection_id,
                   decision, decided_at, granted_generation,
                   resume_secret_digest)
       ON TABLE community.agent_connection_consents TO %I', consent_role);

  -- The connection authority, under compare-and-set on version. The UPDATE list
  -- is what `compareAndSet` round-trips; the identity columns in it are frozen by
  -- the table's own trigger. `current_grant_id` stays the provider's alone.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connections TO %I', consent_role);
  EXECUTE format(
    'GRANT INSERT (id, human_account_id, client_family, oauth_client_id,
                   environment, principal_label, preset, status, generation,
                   consented_at, revoked_at)
       ON TABLE community.agent_connections TO %I', consent_role);
  EXECUTE format(
    'GRANT UPDATE (
       principal_label, human_account_id, client_family, oauth_client_id,
       environment, preset, status, generation, version, consented_at,
       revoked_at, provider_cleanup_status, provider_cleanup_error
     ) ON TABLE community.agent_connections TO %I', consent_role);

  -- Read-only on the snapshot, for display. It cannot forge one.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connection_grants TO %I',
    consent_role);
  EXECUTE format(
    'GRANT SELECT ON TABLE community.schema_migrations TO %I', consent_role);

  -- ------------------------------------------------------------- resource --
  --
  -- The door authenticates requests and decides nothing about authority. It holds
  -- nothing on agent_connection_provider_artifacts or agent_connection_consents.
  EXECUTE format(
    'GRANT SELECT ON TABLE
       community.agent_connections,
       community.agent_connection_grants,
       community.agent_connection_wrappers
     TO %I', resource_role);
  EXECUTE format(
    'GRANT UPDATE (last_verified_at) ON TABLE community.agent_connections TO %I',
    resource_role);
  EXECUTE format(
    'GRANT SELECT ON TABLE community.schema_migrations TO %I', resource_role);
END
$$;
