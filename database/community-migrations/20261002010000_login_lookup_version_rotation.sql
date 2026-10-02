-- Enforce one lookup-key version even across concurrent transactions, while
-- permitting a controlled whole-table rotation in one transaction. Migration
-- authority installs the bundled extension; runtime startup never performs DDL.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE community.user_login_identities
  ADD CONSTRAINT user_login_identities_one_lookup_key_version
  EXCLUDE USING gist (lookup_key_version WITH <>)
  DEFERRABLE INITIALLY IMMEDIATE;

-- Install the constraint first: existing mixed-version data aborts the entire
-- migration, preserving the old trigger and ledger without rewriting records.
DROP TRIGGER user_login_identities_one_lookup_key_version
  ON community.user_login_identities;
DROP FUNCTION community.reject_mixed_login_lookup_key_version();
