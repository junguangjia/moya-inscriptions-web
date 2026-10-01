-- Task-owned disposable Development database only. Existing roles must be
-- provisioned by the controlled runtime owner; no passwords or CREATE ROLE.
-- Article app role also needs the sibling's Article runtime grants. It can
-- consume an approval but cannot create a human approval or provider artifact.
DO $$
DECLARE
  issuer text := current_setting('article_authoring.issuer_role');
  control text := current_setting('article_authoring.control_role');
  resource text := current_setting('article_authoring.resource_role');
BEGIN
  IF issuer=control OR issuer=resource OR control=resource THEN
    RAISE EXCEPTION 'Article issuer, human control and resource roles must be distinct';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=issuer AND NOT rolsuper AND NOT rolbypassrls)
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=control AND NOT rolsuper AND NOT rolbypassrls)
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=resource AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'Pre-provisioned non-superuser Article runtime roles required';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I,%I,%I',current_database(),issuer,control,resource);
  EXECUTE format('GRANT USAGE ON SCHEMA community TO %I,%I,%I',issuer,control,resource);
  EXECUTE format('GRANT SELECT ON community.public_users TO %I,%I,%I',issuer,control,resource);
  -- Existing actor fence uses SELECT FOR NO KEY UPDATE, requiring a column
  -- UPDATE grant. Public identity constraints/ownership remain independently enforced.
  EXECUTE format('GRANT UPDATE(id) ON community.public_users TO %I,%I',control,resource);
  EXECUTE format('GRANT SELECT ON community.article_authoring_connections,community.article_authoring_grants TO %I,%I,%I',issuer,control,resource);
  EXECUTE format('GRANT UPDATE(updated_at) ON community.article_authoring_connections TO %I',resource);
  EXECUTE format('GRANT INSERT ON community.article_authoring_connections TO %I',control);
  EXECUTE format('GRANT UPDATE(generation,status,current_grant_id,consented_at,revoked_at,updated_at) ON community.article_authoring_connections TO %I',control);
  EXECUTE format('GRANT UPDATE(current_grant_id) ON community.article_authoring_connections TO %I',issuer);
  EXECUTE format('GRANT INSERT ON community.article_authoring_grants TO %I',issuer);
  EXECUTE format('GRANT SELECT ON community.article_authoring_consents TO %I,%I',issuer,control);
  EXECUTE format('GRANT INSERT(interaction_uid,oauth_client_id,resource,scopes,expires_at) ON community.article_authoring_consents TO %I',issuer);
  EXECUTE format('GRANT UPDATE(reviewed_owner_id,review_ticket_digest,decision,decision_request_id,decided_at,owner_id,connection_id,granted_generation) ON community.article_authoring_consents TO %I',control);
  EXECUTE format('GRANT UPDATE(resumed_at,provider_grant_id) ON community.article_authoring_consents TO %I',issuer);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON community.article_authoring_provider_artifacts TO %I',issuer);
  EXECUTE format('GRANT SELECT ON community.article_authoring_wrappers TO %I,%I,%I',issuer,control,resource);
  EXECUTE format('GRANT INSERT,DELETE ON community.article_authoring_wrappers TO %I',issuer);
  EXECUTE format('GRANT UPDATE(invalidated_at) ON community.article_authoring_wrappers TO %I,%I',issuer,control);
  EXECUTE format('GRANT SELECT ON community.article_documents TO %I',control);
  -- SELECT FOR SHARE requires one column UPDATE privilege. The immutable
  -- identity/version trigger rejects even a no-op ID update; control cannot
  -- update the version or document and gains no authoring operation.
  EXECUTE format('GRANT UPDATE(id) ON community.article_documents TO %I',control);
  EXECUTE format('GRANT SELECT,INSERT,DELETE ON community.article_publication_reviews TO %I',control);
  EXECUTE format('GRANT UPDATE(approval_id) ON community.article_publication_reviews TO %I',control);
  EXECUTE format('GRANT SELECT ON community.article_publication_approvals TO %I,%I',control,resource);
  EXECUTE format('GRANT INSERT ON community.article_publication_approvals TO %I',control);
  EXECUTE format('GRANT UPDATE(consumed_at,consumed_request_id) ON community.article_publication_approvals TO %I',resource);
END $$;
