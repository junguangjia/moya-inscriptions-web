/**
 * Payload 3.88 PostgreSQL primary document and embedded child tables are the
 * published authority. Draft versions and mutable media-master rows are never
 * joined here. Existing Public API queries retain their DTO and transaction
 * boundary through these views; there is no copied editable projection.
 *
 * OFFSET 0 deliberately makes each view non-updatable in PostgreSQL. Install
 * through a CMS migration in its own database, where these legacy names are
 * absent. Runtime credentials still receive SELECT privileges only.
 */

// The published media rows, shared by the original view text below and by
// its keyed-read upgrade, so the two definitions cannot drift apart.
const publishedCatalogMediaSourceSql = `FROM catalogs_media m
JOIN catalogs c ON c.id = m._parent_id
WHERE c._status = 'published'`;

const publishedCatalogMediaSelectSql = `SELECT
  m.media_id,
  c.catalog_id,
  m.position::integer AS position,
  m.is_representative,
  'image'::text AS kind,
  m.alt AS alt_text,
  m.width::integer AS width,
  m.height::integer AS height,
  m.object_key
${publishedCatalogMediaSourceSql}`;

export const createPublishedCatalogViewsSql = `
CREATE VIEW catalog_entries AS
SELECT
  c.catalog_id,
  c.kind::text AS kind,
  c.title,
  c.summary,
  c.period_label,
  c.dynasty_value AS dynasty,
  c.dynasty_state::text AS dynasty_state,
  c.date_text_value AS date_text,
  c.date_text_state::text AS date_text_state,
  c.province_value AS province,
  c.province_state::text AS province_state,
  c.prefecture_value AS prefecture,
  c.prefecture_state::text AS prefecture_state,
  c.county_value AS county,
  c.county_state::text AS county_state,
  c.current_location_value AS current_location,
  c.current_location_state::text AS current_location_state,
  c.current_custodian_value AS current_custodian,
  c.current_custodian_state::text AS current_custodian_state,
  CASE WHEN c.description_state = 'VALUE' THEN c.description_value END AS description,
  c.script_style_value AS script_style,
  c.script_style_state::text AS script_style_state,
  c.transcription_value AS transcription,
  c.transcription_state::text AS transcription_state,
  c.historical_context_value AS historical_context,
  c.historical_context_state::text AS historical_context_state,
  c.scholarly_research_value AS scholarly_research,
  c.scholarly_research_state::text AS scholarly_research_state
FROM catalogs c
WHERE c._status = 'published'
OFFSET 0;

CREATE VIEW catalog_aliases AS
SELECT c.catalog_id, (a._order - 1)::integer AS position, a.alias
FROM catalogs_aliases a
JOIN catalogs c ON c.id = a._parent_id
WHERE c._status = 'published'
OFFSET 0;

CREATE VIEW catalog_contributors AS
SELECT c.catalog_id, (a._order - 1)::integer AS position, a.name, a.role::text AS role
FROM catalogs_contributors a
JOIN catalogs c ON c.id = a._parent_id
WHERE c._status = 'published'
OFFSET 0;

CREATE VIEW catalog_source_citations AS
SELECT c.catalog_id, (a._order - 1)::integer AS position, a.label, a.citation, a.url
FROM catalogs_source_citations a
JOIN catalogs c ON c.id = a._parent_id
WHERE c._status = 'published'
OFFSET 0;

CREATE VIEW catalog_source_citation_scopes AS
SELECT c.catalog_id, (a._order - 1)::integer AS citation_position, s.value::text AS scope
FROM catalogs_source_citations_applies_to s
JOIN catalogs_source_citations a ON a.id = s.parent_id
JOIN catalogs c ON c.id = a._parent_id
WHERE c._status = 'published'
OFFSET 0;

CREATE VIEW catalog_media AS
${publishedCatalogMediaSelectSql}
OFFSET 0;
`;

export const dropPublishedCatalogViewsSql = `
DROP VIEW catalog_media;
DROP VIEW catalog_source_citation_scopes;
DROP VIEW catalog_source_citations;
DROP VIEW catalog_contributors;
DROP VIEW catalog_aliases;
DROP VIEW catalog_entries;
`;

/*
 * catalog-scale-v1 (M1): keyed reads of catalog_media. Without OFFSET 0 a
 * caller's leakproof restriction (media_id = ANY($1), catalog_id = $1) enters
 * the view and reaches the indexes, so a read costs the rows it asks for, not
 * the published list. security_barrier takes over the fence's other role: a
 * caller's non-leakproof function never sees a draft row, and the join keeps
 * the view non-updatable. It does not cover a leakproof comparison on a cast
 * column (position = 1), which enters with the column's expression; a bare
 * m.position::integer would then run on draft rows and fail with 22003 on an
 * out-of-range draft value. Each cast is therefore guarded by the record's
 * status, which keeps it on published rows wherever the comparison lands and
 * leaves every value the view returns unchanged.
 * The index is on media_id alone: with media_id and object_key bound as two
 * arrays, a two-column index is priced so high that PostgreSQL 18 chose a Seq
 * Scan for 100 pairs among 20,000 rows; object_key is a cheap filter on the
 * few rows found. Same columns, join and filter; CREATE OR REPLACE keeps
 * the OID, owner and grants. The index is built before the view swap so the
 * view's ACCESS EXCLUSIVE lock is held briefly, and lock_timeout makes the
 * migration fail (to be re-run) instead of queueing public reads behind a
 * long transaction. Payload runs each migration in one transaction.
 */
export const upgradePublishedCatalogMediaViewSql = `
SET LOCAL lock_timeout = '5s';
CREATE INDEX catalogs_media_media_id_lookup_idx
  ON catalogs_media USING btree (media_id);
CREATE OR REPLACE VIEW catalog_media WITH (security_barrier = true) AS
SELECT
  m.media_id,
  c.catalog_id,
  CASE WHEN c._status = 'published' THEN m.position::integer END AS position,
  m.is_representative,
  'image'::text AS kind,
  m.alt AS alt_text,
  CASE WHEN c._status = 'published' THEN m.width::integer END AS width,
  CASE WHEN c._status = 'published' THEN m.height::integer END AS height,
  m.object_key
${publishedCatalogMediaSourceSql};
`;

/** Restores the original view text, its empty options and the bare table. */
export const downgradePublishedCatalogMediaViewSql = `
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE VIEW catalog_media AS
${publishedCatalogMediaSelectSql}
OFFSET 0;
ALTER VIEW catalog_media RESET (security_barrier);
DROP INDEX catalogs_media_media_id_lookup_idx;
`;
