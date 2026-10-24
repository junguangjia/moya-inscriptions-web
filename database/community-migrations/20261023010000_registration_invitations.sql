-- Invitation authority is managed by the offline operator, never by App DML.
CREATE TABLE community.registration_invitations (
  id TEXT PRIMARY KEY CHECK (id ~ '^invitation-[0-9a-f]{32}$'),
  digest TEXT NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
  environment TEXT NOT NULL CHECK (environment IN ('development','production')),
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 10000),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE TABLE community.registration_invitation_redemptions (
  user_id TEXT PRIMARY KEY REFERENCES community.public_users(id),
  invitation_id TEXT NOT NULL REFERENCES community.registration_invitations(id),
  redeemed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE community.beta_account_access (
  user_id TEXT PRIMARY KEY REFERENCES community.public_users(id),
  state TEXT NOT NULL CHECK (state IN ('granted','revoked')),
  invitation_id TEXT REFERENCES community.registration_invitations(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE community.auth_challenges ADD COLUMN invitation_id TEXT
  REFERENCES community.registration_invitations(id);
ALTER TABLE community.auth_challenges ADD CONSTRAINT auth_challenges_invitation_registration
  CHECK (invitation_id IS NULL OR (purpose='register' AND channel='email'));
ALTER TABLE community.auth_handoffs ADD COLUMN invitation_id TEXT
  REFERENCES community.registration_invitations(id);
ALTER TABLE community.auth_handoffs ADD CONSTRAINT auth_handoffs_invitation_registration
  CHECK (invitation_id IS NULL OR (purpose='register_confirm' AND channel='email'));
REVOKE ALL ON community.registration_invitations,
  community.registration_invitation_redemptions, community.beta_account_access FROM PUBLIC;

-- SELECT FOR UPDATE needs UPDATE authority, so expose a fixed locking function
-- instead of granting App an invitation mutation capability.
CREATE FUNCTION community.lock_registration_invitation(invitation TEXT)
RETURNS SETOF community.registration_invitations
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, community
AS $function$
  SELECT * FROM community.registration_invitations WHERE id=invitation FOR UPDATE;
$function$;
REVOKE ALL ON FUNCTION community.lock_registration_invitation(TEXT) FROM PUBLIC;

-- Quota, redemption and admission commit with the registering User/identity.
-- A runtime caller cannot use this to admit an existing arbitrary account.
CREATE FUNCTION community.redeem_registration_invitation(invitation TEXT, account TEXT, at_time TIMESTAMPTZ, registration_handoff TEXT)
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
    AND u.xmin=pg_current_xact_id()::text::xid AND u.created_at=CURRENT_TIMESTAMP)
    THEN RETURN FALSE; END IF;
  PERFORM h.id FROM community.auth_handoffs h
    JOIN community.user_login_identities i ON i.user_id=account AND i.kind='email'
      AND i.lookup_digest=h.target_digest AND i.environment=h.environment
      AND i.verification_mode=h.provider_mode AND i.xmin=pg_current_xact_id()::text::xid
    WHERE h.id=registration_handoff AND h.invitation_id=invitation
      AND h.purpose='register_confirm' AND h.channel='email'
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
REVOKE ALL ON FUNCTION community.redeem_registration_invitation(TEXT,TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC;
