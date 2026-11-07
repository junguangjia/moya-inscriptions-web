-- home-timeline-v1 (Issue #384): the rows of the Home timeline. Most rows have
-- no Catalog record; catalog_id is a soft link to a Catalog id on the published
-- read connection, so there is no foreign key, and the read keeps a link only
-- while its record is published. Forward-only and additive. This migration
-- carries structure only: the rows arrive through scripts/import-timeline.mjs
-- with the migration role, and afterwards change only through the Backend's
-- operator routes (Owner and AI, Issue #384 r3), which the import then guards.
--
-- Deploy order: apply this migration, re-apply the named runtime grants
-- (grant-runtime.sql), run the import, then start the release. The previous
-- release starts with this applied: it reads no new relation.
--
-- Every writer validates each row and the whole set against packages/contracts;
-- that is the guard for the response schema of GET /v1/community/timeline.
-- These checks repeat its shape as a coarser backstop: they count code points
-- and trim spaces only.
--
-- version, hidden_at and the actor columns serve the operator routes: a write
-- names the version it read, a hidden row leaves the public read, and created_by
-- / updated_by hold 'import' or the operator label the Backend passes ('owner'
-- or 'ai-admin'). A new label needs a migration.
CREATE TABLE community.timeline_entries (
  entry_id text PRIMARY KEY,
  title text NOT NULL,
  full_title text NOT NULL,
  start_year integer NOT NULL,
  end_year integer NOT NULL,
  precision text NOT NULL,
  date_label text,
  on_axis boolean NOT NULL,
  chapter text NOT NULL,
  polity text,
  disputed boolean NOT NULL,
  group_id text,
  group_title text,
  province text,
  holder text,
  catalog_id text,
  position integer NOT NULL,
  version integer NOT NULL DEFAULT 1,
  hidden_at timestamptz,
  created_by text NOT NULL DEFAULT 'import',
  updated_by text NOT NULL DEFAULT 'import',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timeline_entries_id_valid CHECK (entry_id ~ '^[a-z0-9-]{1,64}$'),
  CONSTRAINT timeline_entries_title_bounded CHECK (
    char_length(title) BETWEEN 1 AND 200 AND title = btrim(title)
  ),
  CONSTRAINT timeline_entries_full_title_bounded CHECK (
    char_length(full_title) BETWEEN 1 AND 200 AND full_title = btrim(full_title)
  ),
  -- Years are signed with no year 0: -475 is 前475.
  CONSTRAINT timeline_entries_years_valid CHECK (
    start_year BETWEEN -3000 AND 3000 AND start_year <> 0
    AND end_year BETWEEN -3000 AND 3000 AND end_year <> 0
    AND end_year >= start_year
  ),
  CONSTRAINT timeline_entries_precision_valid CHECK (
    precision IN ('year', 'reign', 'period', 'multi', 'dynasty')
  ),
  CONSTRAINT timeline_entries_chapter_valid CHECK (
    chapter IN (
      '商', '西周', '春秋', '战国', '秦', '西汉', '东汉', '三国', '两晋', '南北朝',
      '隋', '唐', '五代十国', '宋辽金夏', '元', '明', '清', '民国', '当代'
    )
  ),
  CONSTRAINT timeline_entries_labels_bounded CHECK (
    (date_label IS NULL OR (char_length(date_label) BETWEEN 1 AND 200 AND date_label = btrim(date_label)))
    AND (polity IS NULL OR (char_length(polity) BETWEEN 1 AND 200 AND polity = btrim(polity)))
    AND (province IS NULL OR (char_length(province) BETWEEN 1 AND 200 AND province = btrim(province)))
    AND (holder IS NULL OR (char_length(holder) BETWEEN 1 AND 200 AND holder = btrim(holder)))
  ),
  -- A group has both an id and a title, or neither.
  CONSTRAINT timeline_entries_group_valid CHECK (
    (group_id IS NULL) = (group_title IS NULL)
    AND (group_id IS NULL OR group_id ~ '^[a-z0-9-]{1,64}$')
    AND (group_title IS NULL OR (char_length(group_title) BETWEEN 1 AND 200 AND group_title = btrim(group_title)))
  ),
  CONSTRAINT timeline_entries_catalog_id_valid CHECK (
    catalog_id IS NULL OR catalog_id ~ '^\S{1,128}$'
  ),
  CONSTRAINT timeline_entries_position_bounded CHECK (
    position BETWEEN 0 AND 2000000000
  ),
  CONSTRAINT timeline_entries_version_valid CHECK (version >= 1),
  CONSTRAINT timeline_entries_actors_valid CHECK (
    created_by IN ('import', 'owner', 'ai-admin')
    AND updated_by IN ('import', 'owner', 'ai-admin')
  )
);

-- One row links one Catalog record at most; most rows link none.
CREATE UNIQUE INDEX timeline_entries_catalog_id_unique
  ON community.timeline_entries (catalog_id)
  WHERE catalog_id IS NOT NULL;

-- The read order of GET /v1/community/timeline.
CREATE INDEX timeline_entries_order
  ON community.timeline_entries (start_year, position, entry_id);
