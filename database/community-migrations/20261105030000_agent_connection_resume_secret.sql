-- admin-mcp-completion-v1 (Issue #355, login door): tie an approval to the
-- browser that clicked it. Forward-only; no data change. Amendment 2026-11-05,
-- section 5.
--
-- WHY. Resume used to need only the provider's cookie and an approved row. The
-- clients on the list are public and have no secret of their own, so a stranger
-- could start a real request in their own browser, send the consent link to an
-- administrator, wait for the click, and then finish the interaction with the
-- cookie they already held. The audit would name the victim.
--
-- So approving also mints a one-time secret and hands it only to the browser
-- that clicked. Resume needs both: the cookie says which browser started the
-- request, the secret says which browser approved it. A stranger holds one and
-- a phished administrator holds the other.
--
-- Only the digest is stored. The consent role writes it with the decision and
-- the provider role reads it; neither ever holds the secret afterwards.
ALTER TABLE community.agent_connection_consents
  ADD COLUMN resume_secret_digest TEXT
    CHECK (resume_secret_digest ~ '^[0-9a-f]{64}$'),
  -- Written in the same statement as the approval, never ahead of it, and never
  -- on a denial, which gives the browser nothing to finish. IS NOT DISTINCT FROM
  -- because `decision = 'approved'` is NULL on an undecided row, and a CHECK
  -- passes on NULL.
  ADD CONSTRAINT agent_connection_consents_resume_secret_follows_approval
    CHECK (resume_secret_digest IS NULL
           OR decision IS NOT DISTINCT FROM 'approved'),
  -- The fail-closed half. An operator approval that forgot its secret is refused
  -- here rather than becoming a consent any cookie can finish. Read-only rows
  -- are exempt because that Development-only profile predates the secret and
  -- its rows must keep their meaning.
  ADD CONSTRAINT agent_connection_consents_operator_approval_has_resume_secret
    CHECK (preset <> 'operator' OR decision IS DISTINCT FROM 'approved'
           OR resume_secret_digest IS NOT NULL);

-- The function as 20260920050000 wrote it, plus one clause: the secret is written
-- with the decision and never moves after it. Without that clause the consent
-- role, which must hold the column, could swap the digest on an approved row
-- and hand the approval to a browser that never clicked.
CREATE OR REPLACE FUNCTION community.agent_connection_consents_freeze()
RETURNS TRIGGER AS $$
BEGIN
  -- What the provider will enforce, and what the human is shown, never moves.
  IF NEW.interaction_uid IS DISTINCT FROM OLD.interaction_uid
     OR NEW.oauth_client_id IS DISTINCT FROM OLD.oauth_client_id
     OR NEW.resource IS DISTINCT FROM OLD.resource
     OR NEW.capability_scopes IS DISTINCT FROM OLD.capability_scopes
     OR NEW.protocol_scopes IS DISTINCT FROM OLD.protocol_scopes
     OR NEW.preset IS DISTINCT FROM OLD.preset
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a consent is decided from what the provider will enforce'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The review page may re-arm an UNDECIDED interaction -- reloading it mints
  -- a fresh ticket and kills the old one, which is what single-use means for
  -- a page somebody opened twice. After a decision, nothing here moves.
  IF OLD.decided_at IS NOT NULL
     AND (NEW.ticket_digest IS DISTINCT FROM OLD.ticket_digest
          OR NEW.human_account_id IS DISTINCT FROM OLD.human_account_id
          OR NEW.connection_id IS DISTINCT FROM OLD.connection_id) THEN
    RAISE EXCEPTION 'a decided consent keeps the identity it was decided under'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- One decision, then never another. This is what makes the ticket
  -- single-use even if two approvals arrive concurrently: the second finds a
  -- decided row and is refused by the database, not by a race this code won.
  IF OLD.decided_at IS NOT NULL
     AND (NEW.decision IS DISTINCT FROM OLD.decision
          OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
          OR NEW.granted_generation IS DISTINCT FROM OLD.granted_generation) THEN
    RAISE EXCEPTION 'a consent decision is final'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The secret belongs to the browser that made the decision.
  IF OLD.decided_at IS NOT NULL
     AND NEW.resume_secret_digest IS DISTINCT FROM OLD.resume_secret_digest THEN
    RAISE EXCEPTION 'a resume secret is written with the approval and never moves'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- One resume, then never another, so an approved interaction cannot be
  -- replayed into a second grant.
  IF OLD.resumed_at IS NOT NULL
     AND (NEW.resumed_at IS DISTINCT FROM OLD.resumed_at
          OR NEW.grant_id IS DISTINCT FROM OLD.grant_id) THEN
    RAISE EXCEPTION 'a resumed interaction is spent'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
