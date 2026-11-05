-- agent-connections-v1 (Issue #141 r15): the two roles the r13 grant plan said
-- would have to exist the day the authorization service did.
--
-- infra/development/work-publishing/grant-runtime.sql says, of
-- agent_connection_provider_artifacts and agent_connection_wrappers:
--
--   "The intent is a SECOND SQL role owned by the authorization service, not
--    this shared App role ... That role does not exist yet because the service
--    does not, and the day it lands this file stops being the whole grant plan."
--
-- The service landed. This is the rest of the plan, and it splits into THREE
-- roles rather than one, because the path has three parts that must not be
-- able to do each other's job:
--
--   provider role  -- the OAuth provider. Owns the protocol's own storage and
--                     mints tokens. Never sees an Owner session, and cannot
--                     record a consent decision.
--   consent role   -- the Admin control plane. Authenticates the Owner and
--                     records decisions. Cannot mint a grant or a token.
--   resource role  -- the Admin's MCP boundary. May only READ a connection,
--                     its grant and a wrapper, and stamp when a request last
--                     authenticated. Cannot consent, mint or revoke.
--   backend role   -- the Backend that answers the agent tools. Reads public
--                     users and keeps the principal registry. Knows nothing
--                     about connections, grants, wrappers or consents.
--
-- None is a superuser and none is the migration account.
--
-- Run as the database owner, after the community migrations, having named all
-- THREE roles first. `current_setting` has no default here on purpose: a
-- missing name raises 42704 rather than silently granting nothing.
--
--   SELECT set_config('agent_connections.provider_role', 'yoyi_dev_auth', false);
--   SELECT set_config('agent_connections.consent_role',  'yoyi_dev_consent', false);
--   SELECT set_config('agent_connections.resource_role', 'yoyi_dev_resource', false);
--
-- The whole file is ONE plain DO block on purpose. A psql-only spelling with
-- \gexec or :'variables' could not be executed by a driver, which would mean
-- the committed regression tested a re-typed copy of these grants rather than
-- this file. Every GRANT below is therefore the one a test actually runs.
--
-- Synthetic local passwords only. These roles do not exist in Production,
-- which provisions its own credentials independently.
DO $$
DECLARE
  provider_role text := current_setting('agent_connections.provider_role');
  consent_role  text := current_setting('agent_connections.consent_role');
  resource_role text := current_setting('agent_connections.resource_role');
  -- Optional: only the acceptance harness needs a Backend role, and the
  -- Development runbook does not. `missing_ok` keeps this file usable by
  -- both rather than forcing every caller to name a role it will not use.
  backend_role  text := current_setting('agent_connections.backend_role', true);
BEGIN
  IF provider_role = consent_role
     OR provider_role = resource_role
     OR consent_role = resource_role THEN
    RAISE EXCEPTION 'the provider, consent and resource roles must be distinct; splitting them IS the control';
  END IF;

  -- The backend role, when one is named, is the fourth in that split and is
  -- held to the same rule. An independent review pointed out that the check
  -- above predates it: naming the backend role as one of the other three
  -- would simply have added the backend's SELECT grants to that role, which
  -- is the opposite of what a split is for.
  IF backend_role IS NOT NULL AND backend_role <> ''
     AND (backend_role = provider_role
          OR backend_role = consent_role
          OR backend_role = resource_role) THEN
    RAISE EXCEPTION 'the backend role must be distinct from the provider, consent and resource roles';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = provider_role) THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      provider_role, 'synthetic-local-provider-only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = consent_role) THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      consent_role, 'synthetic-local-consent-only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = resource_role) THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      resource_role, 'synthetic-local-resource-only');
  END IF;
  IF backend_role IS NOT NULL AND backend_role <> ''
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = backend_role) THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
      backend_role, 'synthetic-local-backend-only');
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I',
    current_database(), provider_role, consent_role, resource_role);
  EXECUTE format('GRANT USAGE ON SCHEMA community TO %I, %I, %I',
    provider_role, consent_role, resource_role);

  -- ------------------------------------------------------------- provider --
  --
  -- The protocol's own bookkeeping. This is the only role that writes it,
  -- which is the whole reason it exists: an injection in the resource-server
  -- path now reaches a role that can only SELECT a wrapper, not rewrite the
  -- token store.
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
       community.agent_connection_provider_artifacts TO %I', provider_role);

  -- Wrappers are minted when a token is issued and reaped when it expires.
  -- Both happen here, not on the resource-server path.
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
       community.agent_connection_wrappers TO %I', provider_role);

  -- The immutable consent snapshot. INSERT only: the provider writes a grant
  -- row when it creates a grant, and the table's freeze trigger refuses every
  -- later edit except the destruction columns. No UPDATE is granted on
  -- generation_at_consent because nothing may ever move it -- that is the r12
  -- defect, and the ABSENCE of the privilege is the last line of that defence.
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE community.agent_connection_grants TO %I',
    provider_role);
  EXECUTE format(
    'GRANT UPDATE (destroy_status, destroyed_at)
       ON TABLE community.agent_connection_grants TO %I', provider_role);

  -- The provider may point a connection at the grant it just made, and
  -- nothing else. It cannot authorize, revoke or move a generation: a
  -- provider that could do those could manufacture an authorization with no
  -- human anywhere in it.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connections TO %I', provider_role);
  EXECUTE format(
    'GRANT UPDATE (current_grant_id) ON TABLE community.agent_connections TO %I',
    provider_role);

  -- The provider OPENS the interaction, writing only what it will enforce,
  -- and later marks it spent. It reads the decision somebody else made.
  --
  -- The INSERT is a COLUMN LIST, and that is the whole control. An earlier
  -- version granted table-level INSERT with a comment claiming "INSERT alone
  -- cannot approve: `decision` starts NULL and the provider holds no
  -- privilege that could move it". That was FALSE, and an independent review
  -- caught it: the provider does not have to MOVE `decision`, it can write it
  -- in the first place. Measured on the live schema before the fix -- the
  -- provider role inserted a row with decision='approved' and a generation,
  -- satisfying every CHECK, and then held the rest of the path (resumed_at,
  -- a grant INSERT, current_grant_id) to turn it into a mintable token.
  --
  -- The freeze trigger is BEFORE UPDATE and never fires on INSERT, so it was
  -- never the backstop that comment assumed.
  --
  -- DELIBERATELY ABSENT from this list: decision, decided_at,
  -- granted_generation, ticket_digest, human_account_id, connection_id,
  -- resumed_at and grant_id. The provider never authenticates a human, so it
  -- must not be able to say who consented, know the browser's single-use
  -- secret, or record a decision -- at INSERT or at UPDATE.
  --
  -- `resume_secret_digest` is absent from the INSERT and UPDATE lists for the same
  -- reason. SELECT lets it compare the digest; it never holds the secret.
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

  -- Startup readiness verifies the ledger read-only, exactly as the App role.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.schema_migrations TO %I', provider_role);

  -- -------------------------------------------------------------- consent --
  --
  -- The Admin control plane. It says WHO is deciding and about WHICH
  -- connection, then records the decision. It cannot create an interaction,
  -- so it cannot conjure an authorization request nobody made, and it cannot
  -- alter what the provider will enforce.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connection_consents TO %I',
    consent_role);
  EXECUTE format(
    'GRANT UPDATE (ticket_digest, human_account_id, connection_id,
                   decision, decided_at, granted_generation,
                   resume_secret_digest)
       ON TABLE community.agent_connection_consents TO %I', consent_role);

  -- The connection authority: status, generation and the consent timestamp
  -- move here and only here, under compare-and-set on version.
  --
  -- The INSERT is a column list for the same reason the provider's is. A
  -- table-level INSERT let this role create a connection row already pointing
  -- at any grant id it could read, which contradicted the stated absent
  -- privilege below even though `admitGrant` refuses the result.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_connections TO %I', consent_role);
  EXECUTE format(
    'GRANT INSERT (id, human_account_id, client_family, oauth_client_id,
                   environment, principal_label, preset, status, generation,
                   consented_at, revoked_at)
       ON TABLE community.agent_connections TO %I', consent_role);
  -- The column list matches what `compareAndSet` actually writes: the store
  -- round-trips the whole consented shape under one conditional UPDATE, so a
  -- narrower grant makes every lifecycle transition fail with 42501. Narrowing
  -- it further means narrowing the store first, which is a separate change
  -- with its own concurrency argument.
  --
  -- What stays absent is the column that matters: `current_grant_id`. The
  -- control plane must not be able to re-point a connection at a grant it did
  -- not create, and that is the provider's column alone.
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

  -- The machine principal a consent provisions.
  --
  -- WHY THIS PRIVILEGE EXISTS AT ALL. Until now nothing wrote
  -- `community.agent_principals` outside a harness that pre-seeded it through
  -- the database owner, so a connection a human actually approved
  -- authenticated and was then refused by the Backend on every business tool.
  -- Onboarding was only ever completable by hand.
  --
  -- INSERT, SELECT, and UPDATE ON ONE COSMETIC COLUMN. The two columns that
  -- decide authority are out of reach on every row.
  --
  -- An independent review pointed out that the first version of this grant was
  -- bounded in one dimension and unbounded in the other: a column list, yes,
  -- but over EVERY ROW. `scopes` and `enabled` are exactly the two columns the
  -- Backend authorizes on, so at the SQL level the control plane could have
  -- widened any non-revoked principal in the registry -- including an
  -- Owner-created operations principal that has nothing to do with agent
  -- connections. The comment said "bounded" and a reader would have believed
  -- it. Nothing in the application did that; the bound was the code, not the
  -- grant, and a grant is what has to hold when the code is wrong.
  --
  -- `provisionPrincipal` is CREATE-ONLY now -- it never writes a row that
  -- already exists, it refuses instead -- so the broad UPDATE had no remaining
  -- caller. Dropping it ENTIRELY was the first attempt and it does not work:
  -- `writePrincipal` locks the row with `SELECT ... FOR UPDATE`, and
  -- PostgreSQL requires an UPDATE privilege on at least one column to take a
  -- row lock. Measured, not predicted -- with no UPDATE at all, every consent
  -- failed with CONSENT_UNAVAILABLE.
  --
  -- So exactly one column is granted, and it is chosen for being unable to
  -- decide anything: `display_name`. What that buys, as a property of the
  -- database rather than of a function:
  --
  --   * `scopes` and `enabled` -- the two columns the Backend authorizes on --
  --     cannot be written by this role on ANY row. The concrete scenario a
  --     review raised against the previous grant, setting `operations:execute`
  --     on an Owner-created operations principal, is now refused by
  --     PostgreSQL rather than merely not attempted by the code.
  --   * a principal an Owner revoked stays revoked, one they disabled stays
  --     disabled, and one whose scopes they narrowed stays narrowed.
  --   * WHAT REMAINS, stated rather than glossed: this role can write
  --     `display_name` on any row in the registry. That is cosmetic --
  --     nothing reads it for a decision -- but it is a real residual, and
  --     "the grant is minimal" would be too strong a sentence for it. It is
  --     minimal among the shapes that still permit a row lock.
  --   * INSERT can only ever create a label that does not exist, because the
  --     label is the primary key. The label it uses is `principal_label` off
  --     the connection row, minted at creation and frozen by the trigger in
  --     20260920060000, so this cannot be used to adopt another connection's
  --     identity either.
  --   * `revoked_at` and `version` stay out of the column list: the first is
  --     an Owner's decision and the second is the registry's own concurrency
  --     token, defaulted on insert.
  --   * nothing on `agent_delegations` or `agent_operations`: this role
  --     provisions a READ-ONLY identity and has no business near delegation,
  --     approval or execution.
  EXECUTE format(
    'GRANT SELECT ON TABLE community.agent_principals TO %I', consent_role);
  EXECUTE format(
    'GRANT INSERT (label, display_name, scopes, enabled, created_at, updated_at)
       ON TABLE community.agent_principals TO %I', consent_role);
  -- Row locking only. See the note above: this is the narrowest UPDATE that
  -- still lets `SELECT ... FOR UPDATE` take a lock, and it deliberately
  -- excludes every column that decides anything.
  EXECUTE format(
    'GRANT UPDATE (display_name) ON TABLE community.agent_principals TO %I',
    consent_role);

  -- ------------------------------------------------------------- resource --
  --
  -- The Admin's MCP boundary. It authenticates requests and decides nothing
  -- about authority, so it reads three tables and writes exactly one column:
  -- when a request last authenticated, which the page shows as an
  -- OBSERVATION. An injection on the resource-server path therefore reaches a
  -- role that cannot mint a token, record a consent or revoke anything.
  --
  -- DELIBERATELY ABSENT: every write except last_verified_at, and any
  -- privilege at all on agent_connection_provider_artifacts and
  -- agent_connection_consents. The resource server has no business near the
  -- protocol's storage or near a decision.
  EXECUTE format(
    'GRANT SELECT ON TABLE
       community.agent_connections,
       community.agent_connection_grants,
       community.agent_connection_wrappers
     TO %I', resource_role);
  EXECUTE format(
    'GRANT UPDATE (last_verified_at) ON TABLE community.agent_connections
     TO %I', resource_role);
  EXECUTE format(
    'GRANT SELECT ON TABLE community.schema_migrations TO %I', resource_role);

  -- -------------------------------------------------------------- backend --
  --
  -- The Backend that answers the agent tools for the READ-ONLY milestone. It
  -- reads public users and reads the principal registry the agent boundary
  -- checks scopes against.
  --
  -- SELECT AND NOTHING ELSE. The read-only preset reaches `usersFind`,
  -- `contentSearch` and `commentsQuery`, and none of those writes; the
  -- principal itself is registered by the harness that owns the database,
  -- through the database owner, before this role's process starts. An earlier
  -- version granted INSERT and UPDATE on `agent_principals` "because the
  -- boundary also has Owner-mode routes", which would have let the read-only
  -- acceptance Backend widen its own scopes -- the exact thing the split
  -- exists to prevent. A management milestone that needs writes adds them
  -- then, with its own evidence.
  --
  -- DELIBERATELY ABSENT: every agent_connection* table. The Backend must not
  -- be able to read a wrapper, a grant, a consent or a connection -- it never
  -- sees a token, only the principal label the Admin's MCP adapter asserts
  -- after IT has authenticated the request.
  IF backend_role IS NOT NULL AND backend_role <> '' THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',
      current_database(), backend_role);
    EXECUTE format('GRANT USAGE ON SCHEMA community TO %I', backend_role);
    EXECUTE format(
      'GRANT SELECT ON TABLE
         community.public_users,
         community.agent_principals,
         community.agent_delegations,
         community.agent_operations
       TO %I', backend_role);
  END IF;

  -- DELIBERATELY ABSENT for the consent role:
  --   * UPDATE on agent_principals.scopes and .enabled -- the two columns
  --                         the Backend authorizes on. This role cannot widen
  --                         or re-enable any principal, its own included.
  --   * agent_principals.revoked_at -- a revoked machine identity is an
  --                         Owner's decision, and a consent must not be able
  --                         to set it or clear it.
  --   * agent_delegations, agent_operations -- this role provisions a
  --                         read-only identity; delegation, approval and
  --                         execution are not its business.
  --   * current_grant_id -- the provider's column. The control plane must not
  --                         be able to re-point a connection at a grant it did
  --                         not create.
  --   * last_verified_at -- the resource server's column, and an observation
  --                         rather than a decision.
  --
  -- HELD BUT FROZEN, which is a different and weaker statement: the UPDATE
  -- list above includes human_account_id, oauth_client_id, client_family and
  -- environment, because `compareAndSet` round-trips the whole consented
  -- shape. Migration 20260920060000 freezes all four in the table's own
  -- trigger, so holding the privilege is not the same as being able to use
  -- it. Without that migration this grant would let the control plane move a
  -- live connection out of its owner's disconnect scope.
  --   * INSERT/UPDATE on agent_connection_grants -- it cannot forge a consent
  --                         snapshot.
  --   * agent_connection_wrappers and _provider_artifacts -- no grant at all.
  --                         The control plane has no business near a token
  --                         store and cannot mint or resolve one.

  -- Neither role is granted DELETE on a connection, a grant or a consent
  -- anywhere above: the ledger is append-plus-freeze, and removal is a
  -- retention decision rather than a runtime one.
  --
  -- The REVOKE that used to sit here was a no-op dressed as a control -- it
  -- took back a privilege neither role had ever been given, and it said
  -- nothing about any other role. Removed rather than kept, because a
  -- statement that looks like enforcement and enforces nothing is worse than
  -- no statement. What actually holds is the absence of the grant, and the
  -- committed regression asserts the refusal.
END
$$;
