-- timeline-posts-v1: a user's post (a community.works row) attached to one row
-- of the Home timeline. A post IS a work; this table only associates it, as
-- community.thread_works does for Threads, so the works table and its grants
-- stay as they are. One row per work: a post sits under at most one entry.
-- Forward-only and additive.
--
-- state: 'attached' while the post shows under entry_id; 'detached' after its
-- author took it off; 'withheld' after an operator (Owner or AI) took it off.
-- entry_id is set exactly while the row is attached, so a row that is not
-- attached never points at an entry. withheld_entry_id keeps the entry an
-- operator last took the post off: its author may attach it to another entry,
-- but not back to that one. It is a plain id, not a foreign key, so it never
-- holds back a timeline import.
--
-- Rows are never deleted through the App role: a move, a detach and a withhold
-- are updates. attached_by / updated_by name 'author' or the operator label
-- the Backend passes ('owner' or 'ai-admin'); a new label needs a migration.
-- version serves the operator routes' compare-and-set, and every change bumps
-- it, the author's included.
--
-- scripts/import-timeline.mjs deletes every timeline row and inserts the file's
-- rows again under the same ids, in one transaction. The entry foreign key is
-- therefore checked at commit (DEFERRABLE INITIALLY DEFERRED, NO ACTION): a
-- re-inserted id satisfies it, and the import refuses, with counts only and
-- inside the same transaction, a file that drops an entry with attached posts.
-- RESTRICT would fail on the DELETE itself, and CASCADE would silently drop
-- the authors' attachments.
--
-- Deploy order: apply this migration, re-apply the named runtime grants
-- (grant-runtime.sql), then start the release. The previous release starts
-- with this applied: it reads no new relation.
CREATE TABLE community.timeline_entry_posts (
  work_id text PRIMARY KEY REFERENCES community.works(id),
  entry_id text REFERENCES community.timeline_entries(entry_id)
    DEFERRABLE INITIALLY DEFERRED,
  state text NOT NULL DEFAULT 'attached',
  withheld_entry_id text,
  attached_by text NOT NULL,
  updated_by text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  attached_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timeline_entry_posts_state_valid CHECK (
    state IN ('attached', 'detached', 'withheld')
  ),
  CONSTRAINT timeline_entry_posts_entry_while_attached CHECK (
    (state = 'attached') = (entry_id IS NOT NULL)
  ),
  CONSTRAINT timeline_entry_posts_withheld_recorded CHECK (
    state <> 'withheld' OR withheld_entry_id IS NOT NULL
  ),
  CONSTRAINT timeline_entry_posts_withheld_id_valid CHECK (
    withheld_entry_id IS NULL OR withheld_entry_id ~ '^[a-z0-9-]{1,64}$'
  ),
  CONSTRAINT timeline_entry_posts_actors_valid CHECK (
    attached_by IN ('author', 'owner', 'ai-admin')
    AND updated_by IN ('author', 'owner', 'ai-admin')
  ),
  CONSTRAINT timeline_entry_posts_version_valid CHECK (version >= 1)
);

-- An entry's posts, newest attachment first, and the per-entry counts.
CREATE INDEX timeline_entry_posts_entry_order
  ON community.timeline_entry_posts (entry_id, attached_at DESC, work_id DESC)
  WHERE state = 'attached';
