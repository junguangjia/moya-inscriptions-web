-- profile-media-renditions-v1, unified-media-pipeline increment 3a (Owner
-- approval 2026-10-13): profile images (community.user_media, keyed by their
-- unchanged public id) become a third rendition subject next to media items
-- and Catalog assets, rendered by the new profile_render job kind.
-- Forward-only and additive: no row is rewritten, no byte is moved, and
-- user_media and public_users keep their schema.
--
-- Deploy order: stop the media worker, the Backend and Admin, take and
-- verify the database backup, apply this migration, re-apply the named
-- runtime grants (unchanged), then start the build that records profile
-- renditions. The previous release ignores profile rows: its readers select
-- renditions by item or Catalog asset only.

-- Every lock is taken at once, before any ALTER, never upgraded midway: the
-- new foreign key needs SHARE ROW EXCLUSIVE on user_media (its readers keep
-- reading), every ALTER below needs ACCESS EXCLUSIVE.
SET LOCAL lock_timeout = '5s';
LOCK TABLE community.user_media IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE community.media_renditions, community.media_blobs, community.publishing_jobs
  IN ACCESS EXCLUSIVE MODE;

-- Profile rendition blobs are recorded and owner-less, like Catalog ones: the
-- store reconciler keeps them and no account capacity ever counts them. The
-- owner stays derivable through media_renditions.user_media_id.
ALTER TABLE community.media_blobs
  DROP CONSTRAINT media_blobs_purpose_valid,
  ADD CONSTRAINT media_blobs_purpose_valid CHECK (
    purpose IN (
      'original', 'standard_master', 'derivative', 'catalog_derivative',
      'profile_derivative'
    )
  ),
  DROP CONSTRAINT media_blobs_owner_matches_purpose,
  ADD CONSTRAINT media_blobs_owner_matches_purpose CHECK (
    (purpose IN ('catalog_derivative', 'profile_derivative')) = (owner_id IS NULL)
  );

-- A profile rendition names its user media row; the profile roles belong to
-- profile subjects only, and profile renditions are unedited WebP stills.
ALTER TABLE community.media_renditions
  ADD COLUMN user_media_id TEXT REFERENCES community.user_media (id),
  DROP CONSTRAINT media_renditions_one_subject,
  ADD CONSTRAINT media_renditions_one_subject CHECK (
    num_nonnulls(item_id, catalog_asset_id, user_media_id) = 1
  ),
  DROP CONSTRAINT media_renditions_role_valid,
  ADD CONSTRAINT media_renditions_role_valid CHECK (
    role IN (
      'thumb', 'cover', 'display', 'viewer', 'full', 'motion',
      'avatar-128', 'avatar-512', 'background-960', 'background-1600'
    )
  ),
  ADD CONSTRAINT media_renditions_profile_roles CHECK (
    (user_media_id IS NOT NULL)
      = (role IN ('avatar-128', 'avatar-512', 'background-960', 'background-1600'))
  ),
  ADD CONSTRAINT media_renditions_profile_unedited_webp CHECK (
    user_media_id IS NULL
    OR (edit_key = 'base' AND content_type = 'image/webp' AND duration_ms IS NULL)
  );

-- Current slot: at most one ready row per profile image and role.
CREATE UNIQUE INDEX media_renditions_profile_ready_unique
  ON community.media_renditions (user_media_id, role)
  WHERE state = 'ready' AND user_media_id IS NOT NULL;
CREATE INDEX media_renditions_user_media_idx
  ON community.media_renditions (user_media_id)
  WHERE user_media_id IS NOT NULL;

-- The complete job kind list (publishingJobKindSchema is its one TypeScript
-- definition; an integration test compares both) with profile rendering.
ALTER TABLE community.publishing_jobs DROP CONSTRAINT publishing_jobs_kind_valid;
ALTER TABLE community.publishing_jobs ADD CONSTRAINT publishing_jobs_kind_valid CHECK (kind IN (
  'process_item','derive_edit','purge_item','purge_blob','expire_session','purge_trashed_work',
  'sweep_staging','reconcile_capacity','catalog_render','publish_media','withdraw_media',
  'verify_withdrawal','reconcile_publication','sweep_published','profile_render'));
