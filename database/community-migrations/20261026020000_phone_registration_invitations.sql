-- The same invitation authority now admits either verified contact channel.
-- Existing rows satisfy the broader checks; no row or grant is rewritten.
ALTER TABLE community.auth_challenges
  DROP CONSTRAINT auth_challenges_invitation_registration,
  ADD CONSTRAINT auth_challenges_invitation_registration
    CHECK (invitation_id IS NULL OR
      (purpose='register' AND channel IN ('email','phone')));
ALTER TABLE community.auth_handoffs
  DROP CONSTRAINT auth_handoffs_invitation_registration,
  ADD CONSTRAINT auth_handoffs_invitation_registration
    CHECK (invitation_id IS NULL OR
      (purpose='register_confirm' AND channel IN ('email','phone')));

-- Same identity, owner, ACL and SECURITY DEFINER boundary. Match the new login
-- identity to this handoff's channel as well as its target and provenance.
CREATE OR REPLACE FUNCTION community.redeem_registration_invitation(invitation TEXT, account TEXT, at_time TIMESTAMPTZ, registration_handoff TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, community
AS $function$
DECLARE
  selected community.registration_invitations%ROWTYPE;
  previous TEXT;
BEGIN
  SELECT invitation_id INTO previous FROM community.registration_invitation_redemptions
    WHERE user_id=account;
  IF FOUND THEN RETURN previous=invitation; END IF;
  SELECT * INTO selected FROM community.registration_invitations WHERE id=invitation FOR UPDATE;
  IF NOT FOUND OR selected.revoked_at IS NOT NULL OR
    selected.expires_at <= GREATEST(at_time, CURRENT_TIMESTAMP) OR selected.used_count >= selected.max_uses
    THEN RETURN FALSE; END IF;
  IF NOT EXISTS (SELECT 1 FROM community.public_users u WHERE u.id=account AND u.status='active'
    AND u.xmin=pg_current_xact_id()::xid AND u.created_at=CURRENT_TIMESTAMP)
    THEN RETURN FALSE; END IF;
  PERFORM h.id FROM community.auth_handoffs h
    JOIN community.user_login_identities i ON i.user_id=account AND i.kind=h.channel
      AND i.lookup_digest=h.target_digest AND i.environment=h.environment
      AND i.verification_mode=h.provider_mode AND i.xmin=pg_current_xact_id()::xid
    WHERE h.id=registration_handoff AND h.invitation_id=invitation
      AND h.purpose='register_confirm' AND h.channel IN ('email','phone')
      AND h.environment=selected.environment AND h.consumed_at IS NULL
      AND h.expires_at > GREATEST(at_time, CURRENT_TIMESTAMP)
    FOR UPDATE OF h;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  INSERT INTO community.registration_invitation_redemptions(user_id,invitation_id,redeemed_at)
    VALUES(account,invitation,at_time);
  UPDATE community.registration_invitations SET used_count=used_count+1 WHERE id=invitation;
  INSERT INTO community.beta_account_access(user_id,state,invitation_id,updated_at)
    VALUES(account,'granted',invitation,at_time);
  RETURN TRUE;
END;
$function$;
