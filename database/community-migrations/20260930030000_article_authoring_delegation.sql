-- special-article-editor-v1: public-user authoring is a separate audience and
-- authority from administrative Agent Connections. Existing rows/tokens stay
-- unchanged. This migration is additive and Development-only composition.
CREATE TABLE community.article_authoring_connections (
  id TEXT PRIMARY KEY CHECK (id ~ '^article-connection-[0-9a-f]{32}$'),
  owner_id TEXT NOT NULL REFERENCES community.public_users(id),
  client_id TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 1024),
  environment TEXT NOT NULL CHECK (environment='development'),
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  status TEXT NOT NULL CHECK (status IN ('authorized','revoked')),
  current_grant_id TEXT,
  consented_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(owner_id,client_id,environment),
  UNIQUE(id,owner_id),
  CHECK ((status='authorized' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE community.article_authoring_grants (
  grant_id TEXT PRIMARY KEY CHECK (char_length(grant_id) BETWEEN 1 AND 256),
  connection_id TEXT NOT NULL REFERENCES community.article_authoring_connections(id),
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  human_subject TEXT NOT NULL REFERENCES community.public_users(id),
  oauth_client_id TEXT NOT NULL CHECK (octet_length(oauth_client_id) BETWEEN 1 AND 1024),
  issuer TEXT NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 512),
  resource TEXT NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 512),
  scopes TEXT[] NOT NULL CHECK (
    scopes=ARRAY['artvenn:article:draft']::TEXT[] OR
    scopes=ARRAY['artvenn:article:draft','artvenn:article:publish']::TEXT[]),
  consented_at TIMESTAMPTZ NOT NULL,
  UNIQUE(grant_id,connection_id,generation),
  UNIQUE(grant_id,connection_id),
  FOREIGN KEY(connection_id,human_subject) REFERENCES community.article_authoring_connections(id,owner_id)
);
ALTER TABLE community.article_authoring_connections ADD CONSTRAINT article_authoring_current_grant
  FOREIGN KEY(current_grant_id,id) REFERENCES community.article_authoring_grants(grant_id,connection_id);

CREATE TABLE community.article_authoring_consents (
  interaction_uid TEXT PRIMARY KEY CHECK (interaction_uid ~ '^[A-Za-z0-9_-]{1,256}$'),
  oauth_client_id TEXT NOT NULL CHECK (octet_length(oauth_client_id) BETWEEN 1 AND 1024),
  resource TEXT NOT NULL CHECK (char_length(resource) BETWEEN 1 AND 512),
  scopes TEXT[] NOT NULL CHECK (
    scopes=ARRAY['artvenn:article:draft']::TEXT[] OR
    scopes=ARRAY['artvenn:article:draft','artvenn:article:publish']::TEXT[]),
  expires_at TIMESTAMPTZ NOT NULL,
  reviewed_owner_id TEXT REFERENCES community.public_users(id),
  review_ticket_digest TEXT CHECK (review_ticket_digest ~ '^[0-9a-f]{64}$'),
  decision TEXT CHECK (decision IN ('approved','denied')),
  decision_request_id UUID,
  decided_at TIMESTAMPTZ,
  owner_id TEXT REFERENCES community.public_users(id),
  connection_id TEXT REFERENCES community.article_authoring_connections(id),
  granted_generation BIGINT,
  resumed_at TIMESTAMPTZ,
  provider_grant_id TEXT REFERENCES community.article_authoring_grants(grant_id),
  CHECK ((decision IS NULL AND decided_at IS NULL AND owner_id IS NULL AND decision_request_id IS NULL)
    OR (decision IS NOT NULL AND decided_at IS NOT NULL AND owner_id IS NOT NULL AND decision_request_id IS NOT NULL)),
  CHECK ((decision IS DISTINCT FROM 'approved' AND connection_id IS NULL AND granted_generation IS NULL)
    OR (decision='approved' AND connection_id IS NOT NULL AND granted_generation IS NOT NULL)),
  CHECK ((resumed_at IS NULL AND provider_grant_id IS NULL)
    OR (resumed_at IS NOT NULL AND provider_grant_id IS NOT NULL AND decision='approved'))
);
CREATE INDEX article_authoring_consents_expiry ON community.article_authoring_consents(expires_at);

-- Reuse the existing encrypted provider adapter and token wrapper machinery;
-- separate tables, configured keys and prefix keep the two audiences isolated.
-- LIKE does not copy foreign keys or triggers, deliberately added below.
CREATE TABLE community.article_authoring_provider_artifacts
  (LIKE community.agent_connection_provider_artifacts INCLUDING ALL);
CREATE TABLE community.article_authoring_wrappers
  (LIKE community.agent_connection_wrappers INCLUDING ALL);
ALTER TABLE community.article_authoring_wrappers ADD CONSTRAINT article_authoring_wrapper_grant
  FOREIGN KEY(grant_id,connection_id,generation)
  REFERENCES community.article_authoring_grants(grant_id,connection_id,generation);

CREATE TABLE community.article_publication_approvals (
  id TEXT PRIMARY KEY CHECK (id ~ '^article-approval-[0-9a-f]{32}$'),
  owner_id TEXT NOT NULL REFERENCES community.public_users(id),
  request_id UUID NOT NULL,
  connection_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  article_id TEXT NOT NULL,
  article_version BIGINT NOT NULL CHECK (article_version BETWEEN 1 AND 9007199254740991),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_request_id UUID,
  UNIQUE(owner_id,request_id),
  FOREIGN KEY(connection_id,owner_id) REFERENCES community.article_authoring_connections(id,owner_id),
  -- A draft candidate has no publication snapshot yet. Its immutable approval
  -- stores version/fingerprint and publication rechecks both transactionally.
  FOREIGN KEY(article_id) REFERENCES community.article_documents(id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK ((consumed_at IS NULL AND consumed_request_id IS NULL) OR (consumed_at IS NOT NULL AND consumed_request_id IS NOT NULL))
);

-- A ticket alone grants nothing: human-session owner, connection generation,
-- exact current candidate and expiry are checked again at the approve action.
CREATE TABLE community.article_publication_reviews (
  ticket_digest TEXT PRIMARY KEY CHECK (ticket_digest ~ '^[0-9a-f]{64}$'),
  owner_id TEXT NOT NULL REFERENCES community.public_users(id),
  connection_id TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  article_id TEXT NOT NULL REFERENCES community.article_documents(id),
  article_version BIGINT NOT NULL CHECK (article_version BETWEEN 1 AND 9007199254740991),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  approval_id TEXT UNIQUE REFERENCES community.article_publication_approvals(id),
  FOREIGN KEY(connection_id,owner_id) REFERENCES community.article_authoring_connections(id,owner_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX article_publication_reviews_owner ON community.article_publication_reviews(owner_id,expires_at);
CREATE FUNCTION community.article_publication_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'approval_id')<>(to_jsonb(OLD)-'approval_id') OR
    (OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id) THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article reviewed candidate is frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER article_publication_review_guard BEFORE UPDATE ON community.article_publication_reviews
  FOR EACH ROW EXECUTE FUNCTION community.article_publication_review_guard();

CREATE FUNCTION community.article_authoring_connection_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.client_id<>OLD.client_id OR NEW.environment<>OLD.environment
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1 THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article connection identity is immutable';
  END IF;
  IF NEW.generation=OLD.generation AND (NEW.status<>OLD.status OR NEW.consented_at<>OLD.consented_at OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article connection transition requires next generation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER article_authoring_connection_identity BEFORE UPDATE ON community.article_authoring_connections
  FOR EACH ROW EXECUTE FUNCTION community.article_authoring_connection_identity_guard();

CREATE FUNCTION community.article_authoring_grant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article consent grant is immutable';
END $$;
CREATE TRIGGER article_authoring_grant_immutable BEFORE UPDATE OR DELETE ON community.article_authoring_grants
  FOR EACH ROW EXECUTE FUNCTION community.article_authoring_grant_immutable();

CREATE FUNCTION community.article_authoring_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.interaction_uid<>OLD.interaction_uid OR NEW.oauth_client_id<>OLD.oauth_client_id OR
    NEW.resource<>OLD.resource OR NEW.scopes<>OLD.scopes OR NEW.expires_at<>OLD.expires_at THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article interaction request is frozen';
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
    NEW.connection_id IS DISTINCT FROM OLD.connection_id OR NEW.granted_generation IS DISTINCT FROM OLD.granted_generation OR
    NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_request_id IS DISTINCT FROM OLD.decision_request_id OR
    NEW.reviewed_owner_id IS DISTINCT FROM OLD.reviewed_owner_id OR NEW.review_ticket_digest IS DISTINCT FROM OLD.review_ticket_digest) THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article human decision is frozen';
  END IF;
  IF OLD.resumed_at IS NOT NULL AND (NEW.resumed_at IS DISTINCT FROM OLD.resumed_at OR NEW.provider_grant_id IS DISTINCT FROM OLD.provider_grant_id) THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article consent has already resumed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER article_authoring_consent_guard BEFORE UPDATE ON community.article_authoring_consents
  FOR EACH ROW EXECUTE FUNCTION community.article_authoring_consent_guard();

CREATE FUNCTION community.article_publication_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['consumed_at','consumed_request_id'])<>(to_jsonb(OLD)-ARRAY['consumed_at','consumed_request_id'])
    OR (OLD.consumed_at IS NOT NULL AND (NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_request_id IS DISTINCT FROM OLD.consumed_request_id)) THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article candidate approval is frozen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER article_publication_approval_guard BEFORE UPDATE ON community.article_publication_approvals
  FOR EACH ROW EXECUTE FUNCTION community.article_publication_approval_guard();

-- Reuse the existing wrapper freeze function, whose row shape is identical.
CREATE TRIGGER article_authoring_wrapper_immutable BEFORE UPDATE ON community.article_authoring_wrappers
  FOR EACH ROW EXECUTE FUNCTION community.agent_connection_wrappers_freeze();
CREATE TRIGGER article_authoring_provider_consume_once BEFORE UPDATE ON community.article_authoring_provider_artifacts
  FOR EACH ROW EXECUTE FUNCTION community.agent_connection_provider_artifacts_consume_once();

COMMENT ON TABLE community.article_publication_approvals IS
  'Human-session-only approval of one exact Article candidate for one delegated connection generation. A model cannot create approvals. Consumption commits with publication.';
