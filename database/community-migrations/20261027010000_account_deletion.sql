-- account-deletion-v1 (Issue #351 r2): self-service account deletion. The
-- public_users row stays as an anonymized tombstone (about fifty foreign keys,
-- runtime grants and audit retention keep it), so deletion is a terminal
-- status, enforced here rather than only by the Backend.
-- Forward-only and additive: no existing row is rewritten, no column changes
-- type and no applied function changes its owner or privileges.
--
-- Deploy order: stop the media worker, the Backend and Admin, take and verify
-- the database backup, apply this migration, re-apply
-- infra/development/work-publishing/grant-runtime.sql (it grants the new
-- relation and the erasure DELETEs), then start the build that knows the
-- `deleted` status. A build released before this migration never writes
-- `deleted` and never queues `purge_deleted_account`.

-- Every lock is taken at once, before any ALTER, never upgraded midway: the
-- new foreign key and trigger need SHARE ROW EXCLUSIVE on public_users, the
-- constraint swaps need ACCESS EXCLUSIVE, the index builds SHARE.
SET LOCAL lock_timeout = '5s';
LOCK TABLE community.public_users, community.publishing_jobs
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE community.auth_challenges, community.auth_handoffs,
  community.auth_receipts IN SHARE MODE;

ALTER TABLE community.public_users
  DROP CONSTRAINT public_users_status_valid,
  ADD CONSTRAINT public_users_status_valid CHECK (
    status IN ('active', 'suspended', 'deleted')
  );

-- `deleted` is terminal: no writer (Admin reinstate, a report suspension or
-- its release, a later deletion attempt) can move a row out of it, and only an
-- active account can enter it, so a suspended account is never deleted around
-- its suspension. Named to fire before the reporting status triggers, so a
-- refused change never bumps reporting_revision. The constraint name lets the
-- adapters report the refusal as a conflict.
CREATE FUNCTION community.guard_public_user_terminal_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
    RAISE EXCEPTION 'deleted account is terminal'
      USING ERRCODE = '23514', CONSTRAINT = 'public_users_status_terminal';
  END IF;
  IF NEW.status = 'deleted' AND OLD.status NOT IN ('active', 'deleted') THEN
    RAISE EXCEPTION 'only an active account can be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'public_users_status_terminal';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER public_users_status_terminal
  BEFORE UPDATE OF status ON community.public_users
  FOR EACH ROW
  EXECUTE FUNCTION community.guard_public_user_terminal_status();

-- A live account keeps at least one login identity (unlink's last-factor
-- rule). A deleted account frees every phone and email for new registrations,
-- so its last identity may go. Same function identity, owner and privileges.
CREATE OR REPLACE FUNCTION community.reject_last_login_identity_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    SELECT count(*)
    FROM community.user_login_identities
    WHERE user_id = OLD.user_id
  ) <= 1 AND NOT EXISTS (
    SELECT 1
    FROM community.public_users
    WHERE id = OLD.user_id AND status = 'deleted'
  ) THEN
    RAISE EXCEPTION 'last login identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

-- An article draft its author deleted keeps its stored title, document and
-- cover (only the editable lifetime ended), and `deleted_at` makes the row
-- terminal. The background purge of a deleted account empties such a row
-- too, so one change stays allowed after `deleted_at`: that erasure alone.
-- The content becomes the canonical empty draft (emptyArticleDocument() and
-- the fingerprint the Backend computes for it), every other column keeps its
-- value except the one version step article_document_identity requires and
-- updated_at, and only while the owner's account is `deleted`. Same function
-- identity, owner and privileges.
CREATE OR REPLACE FUNCTION community.reject_deleted_article_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, community
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    IF NEW.title = ''
      AND NEW.cover_ref_id IS NULL
      AND NEW.document = '{"format":"blocknote","version":1,"blocks":[{"id":"start","type":"paragraph","props":{},"content":[],"children":[]}],"references":{},"galleries":{}}'::jsonb
      AND NEW.fingerprint = '754b50734ee6819405393bb58aeae93bd2dca523d7b9cbd4b5c7ef4ecf5b7648'
      AND to_jsonb(NEW) - ARRAY['version', 'title', 'cover_ref_id', 'document', 'fingerprint', 'updated_at']
        = to_jsonb(OLD) - ARRAY['version', 'title', 'cover_ref_id', 'document', 'fingerprint', 'updated_at']
      AND EXISTS (
        SELECT 1
        FROM community.public_users
        WHERE id = OLD.owner_id AND status = 'deleted'
      )
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Deleted Article drafts cannot be changed' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END;
$$;

-- One row per deleted account, written in the deletion transaction. The
-- request key hash and session id let an exact retry of the request return
-- the same result after the session was revoked; neither is a credential (an
-- HMAC of the idempotency key, an opaque session id). The background purge of
-- works and media records its completion here.
CREATE TABLE community.account_deletions (
  user_id TEXT PRIMARY KEY REFERENCES community.public_users (id),
  request_key_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL,
  purge_state TEXT NOT NULL DEFAULT 'pending',
  purge_completed_at TIMESTAMPTZ,
  CONSTRAINT account_deletions_request_key_sha256 CHECK (
    request_key_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT account_deletions_session_id_opaque CHECK (
    session_id ~ '^session-[0-9a-f]{32}$'
  ),
  CONSTRAINT account_deletions_purge_state_valid CHECK (
    purge_state IN ('pending', 'completed')
  ),
  CONSTRAINT account_deletions_purge_completion CHECK (
    (purge_state = 'completed') = (purge_completed_at IS NOT NULL)
  ),
  CONSTRAINT account_deletions_purge_after_deletion CHECK (
    purge_completed_at IS NULL OR purge_completed_at >= deleted_at
  )
);

REVOKE ALL ON community.account_deletions FROM PUBLIC;

-- The complete job kind list (publishingJobKindSchema is its one TypeScript
-- definition; an integration test compares both) with the account purge.
ALTER TABLE community.publishing_jobs DROP CONSTRAINT publishing_jobs_kind_valid;
ALTER TABLE community.publishing_jobs ADD CONSTRAINT publishing_jobs_kind_valid CHECK (kind IN (
  'process_item','derive_edit','purge_item','purge_blob','expire_session','purge_trashed_work',
  'sweep_staging','reconcile_capacity','catalog_render','publish_media','withdraw_media',
  'verify_withdrawal','reconcile_publication','sweep_published','profile_render',
  'purge_deleted_account'));

-- User-wide proof invalidation, receipt closing and contact erasure scan these
-- tables by owner; until now only sessions had an owner index.
CREATE INDEX auth_challenges_user_idx ON community.auth_challenges (user_id);
CREATE INDEX auth_handoffs_user_idx ON community.auth_handoffs (user_id);
CREATE INDEX auth_receipts_user_idx ON community.auth_receipts (user_id);
