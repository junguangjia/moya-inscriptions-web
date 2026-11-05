-- article-consent-browser-binding-v1: an approval used to reach whichever
-- browser held the provider's interaction cookie, even one the approving author
-- never used. The decision now mints a one-time resume secret for the browser
-- that clicked, and only its digest is kept here. On a decided row a NULL digest
-- means nothing can resume it: spent, voided, or decided before this column.
ALTER TABLE community.article_authoring_consents
  ADD COLUMN resume_secret_digest TEXT CHECK (resume_secret_digest ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT article_authoring_consents_resume_secret_state CHECK (
    resume_secret_digest IS NULL OR (decision IS NOT NULL AND resumed_at IS NULL)
  );

CREATE OR REPLACE FUNCTION community.article_authoring_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.decision IS NOT NULL AND OLD.resume_secret_digest IS NULL AND NEW.resume_secret_digest IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='restrict_violation', MESSAGE='Article consent can no longer resume';
  END IF;
  RETURN NEW;
END $$;
