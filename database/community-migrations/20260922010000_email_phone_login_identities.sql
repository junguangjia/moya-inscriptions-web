-- Email-first authentication (email-auth-v1).
-- Append-only. The App role never runs this file.
--
-- Contact storage:
--   lookup_digest is HMAC-SHA256(lookup key, version || kind || normalized value).
--   The unique key is (kind, lookup_digest). Key version is NOT part of that
--   key, so two versions cannot become two uniqueness islands.
--   A trigger refuses mixed lookup_key_version values in the table. Rotation
--   rewrites every digest under the new key in one migration-privileged
--   transaction; the App role cannot insert a second version beside the first.
--   ciphertext is AES-256-GCM with a separate encryption key. The OTP verifier
--   uses a third key. Raw OTPs, Session tokens and provider payloads are not
--   stored here.
--
-- Email normalization (every entry point): trim; exactly one @; domain to
-- ASCII lowercase via the URL host parser; local-part lowercased for lookup
-- only. Delivery keeps the original local-part spelling. Dots and plus
-- suffixes are preserved. No provider-specific alias merging.
-- Phone normalization: E.164 with country code. This adapter accepts +86 only.
--
-- Local-capture and simulated proofs record verification_mode and environment.
-- Those values are not updated in place, so a later provider switch cannot
-- relabel a development proof as a provider verification.

CREATE TABLE community.user_login_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES community.public_users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  lookup_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  lookup_key_version INTEGER NOT NULL,
  verification_mode TEXT NOT NULL,
  environment TEXT NOT NULL,
  version INTEGER NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT user_login_identities_id_opaque CHECK (id ~ '^login-[0-9a-f]{32}$'),
  CONSTRAINT user_login_identities_kind_valid CHECK (kind IN ('email', 'phone')),
  CONSTRAINT user_login_identities_digest_sha256 CHECK (lookup_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_login_identities_key_version_positive CHECK (lookup_key_version > 0),
  CONSTRAINT user_login_identities_mode_valid CHECK (
    verification_mode IN ('local_capture', 'simulated', 'provider')
  ),
  CONSTRAINT user_login_identities_environment_valid CHECK (
    environment IN ('development', 'production')
  ),
  CONSTRAINT user_login_identities_version_positive CHECK (version > 0),
  CONSTRAINT user_login_identities_user_kind_unique UNIQUE (user_id, kind),
  CONSTRAINT user_login_identities_kind_digest_unique UNIQUE (kind, lookup_digest)
);

CREATE FUNCTION community.reject_mixed_login_lookup_key_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM community.user_login_identities existing
    WHERE existing.lookup_key_version <> NEW.lookup_key_version
      AND existing.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'mixed login lookup key versions'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER user_login_identities_one_lookup_key_version
  BEFORE INSERT OR UPDATE OF lookup_key_version
  ON community.user_login_identities
  FOR EACH ROW
  EXECUTE FUNCTION community.reject_mixed_login_lookup_key_version();

CREATE FUNCTION community.reject_last_login_identity_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    SELECT count(*)
    FROM community.user_login_identities
    WHERE user_id = OLD.user_id
  ) <= 1 THEN
    RAISE EXCEPTION 'last login identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER user_login_identities_keep_one
  BEFORE DELETE ON community.user_login_identities
  FOR EACH ROW
  EXECUTE FUNCTION community.reject_last_login_identity_delete();

CREATE TABLE community.auth_challenges (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  purpose TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  code_verifier TEXT,
  verification_strategy TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  environment TEXT NOT NULL,
  user_id TEXT REFERENCES community.public_users (id) ON DELETE CASCADE,
  session_hash TEXT,
  continuation_hash TEXT NOT NULL,
  expected_version INTEGER,
  reauth_hash TEXT,
  provider_correlation TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL,
  resend_available_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  delivery_state TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT auth_challenges_id_opaque CHECK (id ~ '^challenge-[0-9a-f]{32}$'),
  CONSTRAINT auth_challenges_channel_valid CHECK (channel IN ('email', 'phone')),
  CONSTRAINT auth_challenges_purpose_valid CHECK (
    purpose IN ('sign_in', 'register', 'link', 'replace', 'reauthenticate')
  ),
  CONSTRAINT auth_challenges_strategy_valid CHECK (
    verification_strategy IN ('application_otp', 'provider_generated')
  ),
  CONSTRAINT auth_challenges_strategy_verifier CHECK (
    (
      verification_strategy = 'application_otp'
      AND code_verifier IS NOT NULL
      AND code_verifier ~ '^[0-9a-f]{64}$'
    )
    OR (
      verification_strategy = 'provider_generated'
      AND code_verifier IS NULL
    )
  ),
  CONSTRAINT auth_challenges_mode_valid CHECK (
    provider_mode IN ('local_capture', 'simulated', 'provider')
  ),
  CONSTRAINT auth_challenges_environment_valid CHECK (
    environment IN ('development', 'production')
  ),
  CONSTRAINT auth_challenges_delivery_valid CHECK (
    delivery_state IN ('pending', 'accepted', 'failed', 'unknown')
  ),
  CONSTRAINT auth_challenges_attempts_bounded CHECK (attempts >= 0 AND attempts <= 5),
  CONSTRAINT auth_challenges_idempotency_unique UNIQUE (idempotency_hash)
);

CREATE INDEX auth_challenges_target_idx
  ON community.auth_challenges (channel, purpose, target_digest, created_at DESC);

CREATE TABLE community.auth_handoffs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  channel TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  environment TEXT NOT NULL,
  user_id TEXT REFERENCES community.public_users (id) ON DELETE CASCADE,
  session_hash TEXT,
  expected_version INTEGER,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CONSTRAINT auth_handoffs_id_opaque CHECK (id ~ '^handoff-[0-9a-f]{32}$'),
  CONSTRAINT auth_handoffs_purpose_valid CHECK (
    purpose IN ('register_confirm', 'reauth')
  ),
  CONSTRAINT auth_handoffs_token_sha256 CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

-- Binds a lost registration or sign-in response to the same idempotency key.
-- Stores the session id and token hash only, never the raw Session token.
CREATE TABLE community.auth_receipts (
  key_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES community.public_users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT auth_receipts_key_sha256 CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_receipts_session_hash CHECK (session_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE community.auth_send_counters (
  scope TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket_key, window_start),
  CONSTRAINT auth_send_counters_scope_valid CHECK (
    scope IN ('target', 'source', 'global')
  ),
  CONSTRAINT auth_send_counters_count_positive CHECK (count > 0)
);

CREATE TABLE community.auth_target_failures (
  target_digest TEXT NOT NULL,
  purpose TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (target_digest, purpose, failed_at)
);

CREATE INDEX auth_target_failures_recent_idx
  ON community.auth_target_failures (target_digest, purpose, failed_at DESC);

CREATE TABLE community.auth_audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES community.public_users (id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT auth_audit_events_id_opaque CHECK (id ~ '^auth-audit-[0-9a-f]{32}$'),
  CONSTRAINT auth_audit_events_action_bounded CHECK (
    char_length(action) BETWEEN 1 AND 80
  )
);

-- Provenance of sessions minted by verified login. Null issuer keeps the
-- existing Development handle sessions identifiable by the current reader.
ALTER TABLE community.sessions
  ADD COLUMN issuer TEXT,
  ADD COLUMN auth_environment TEXT,
  ADD COLUMN auth_channel TEXT,
  ADD CONSTRAINT sessions_issuer_valid CHECK (
    issuer IS NULL OR issuer IN ('development_handle', 'verified_login')
  ),
  ADD CONSTRAINT sessions_auth_environment_valid CHECK (
    auth_environment IS NULL OR auth_environment IN ('development', 'production')
  ),
  ADD CONSTRAINT sessions_auth_channel_valid CHECK (
    auth_channel IS NULL OR auth_channel IN ('email', 'phone')
  );
