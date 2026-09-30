-- Password credentials and reset are additive to the existing public-account auth.
-- Existing OTP users receive no default credential. The App role never runs DDL.
ALTER TABLE community.public_users ADD COLUMN studio_name TEXT NOT NULL DEFAULT '';
ALTER TABLE community.public_users ADD CONSTRAINT public_users_studio_name_valid
  CHECK (char_length(studio_name) <= 6 AND studio_name = btrim(studio_name));

CREATE TABLE community.user_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES community.public_users(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT password_verifier_version_valid CHECK (
    verifier ~ '^scrypt-v1\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$'
  )
);

ALTER TABLE community.auth_challenges DROP CONSTRAINT auth_challenges_purpose_valid;
ALTER TABLE community.auth_challenges ADD CONSTRAINT auth_challenges_purpose_valid
  CHECK (purpose IN ('sign_in','register','link','replace','reauthenticate','password_reset'));
ALTER TABLE community.auth_handoffs DROP CONSTRAINT auth_handoffs_purpose_valid;
ALTER TABLE community.auth_handoffs ADD CONSTRAINT auth_handoffs_purpose_valid
  CHECK (purpose IN ('register_confirm','reauth','password_reset'));
ALTER TABLE community.auth_challenges ADD COLUMN identity_id TEXT, ADD COLUMN credential_version INTEGER;
ALTER TABLE community.auth_handoffs ADD COLUMN identity_id TEXT, ADD COLUMN credential_version INTEGER;
ALTER TABLE community.auth_receipts ADD COLUMN payload_hash TEXT, ADD COLUMN credential_version INTEGER;
ALTER TABLE community.auth_receipts ADD CONSTRAINT auth_receipts_payload_hash_valid
  CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');

-- No Session fields: successful reset never authenticates. The payload binds
-- the purpose-bound proof and salted slow verifier, never a fast password hash.
CREATE TABLE community.auth_password_reset_receipts (
  key_hash TEXT PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  user_id TEXT NOT NULL REFERENCES community.public_users(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMPTZ
);
CREATE INDEX auth_password_reset_receipts_user_idx ON community.auth_password_reset_receipts(user_id);
