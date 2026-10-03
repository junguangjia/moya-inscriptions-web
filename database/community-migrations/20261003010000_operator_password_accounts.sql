-- Controlled operator setup on the existing public-user/password/session model.
-- The runtime may only read this authority. No public endpoint creates it.
CREATE TABLE community.operator_password_accounts (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES community.public_users(id),
  handle TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z][a-z0-9-]{2,31}$'),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40 AND display_name=btrim(display_name)),
  environment TEXT NOT NULL CHECK (environment IN ('development','production')),
  operator_label TEXT NOT NULL CHECK (operator_label ~ '^[a-z][a-z0-9-]{2,63}$'),
  credential_version INTEGER NOT NULL CHECK (credential_version=1),
  credential_fingerprint TEXT NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
REVOKE ALL ON community.operator_password_accounts FROM PUBLIC;

ALTER TABLE community.sessions DROP CONSTRAINT sessions_issuer_valid;
ALTER TABLE community.sessions ADD CONSTRAINT sessions_issuer_valid
  CHECK (issuer IS NULL OR issuer IN ('development_handle','verified_login','password_login'));
ALTER TABLE community.sessions ADD CONSTRAINT sessions_password_provenance_valid
  CHECK (issuer IS DISTINCT FROM 'password_login' OR
    (auth_channel IS NULL AND auth_environment IS NOT NULL));
