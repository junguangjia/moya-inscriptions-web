/**
 * Published-only read views for the editorial content collections. Same
 * discipline as `published/views.ts`: only `_status = 'published'` primary rows
 * and their embedded child tables, `OFFSET 0` so the views are non-updatable,
 * and runtime credentials receive SELECT only. Draft and version rows are never
 * joined, so a pending replacement never leaks while the previous published
 * revision stays readable.
 */
export const createPublishedArticleViewsSql = `
CREATE VIEW article_entries AS
SELECT
  a.article_id,
  a.presentation::text AS presentation,
  a.title,
  a.subtitle,
  a.summary,
  a.section,
  a.issue,
  a.byline,
  a.intro,
  a.cover_alt,
  cc.catalog_id AS cover_catalog_id,
  a.revision::integer AS revision,
  a.first_published_at,
  a.published_at,
  a.updated_at
FROM articles a
LEFT JOIN catalogs cc ON cc.id = a.cover_catalog_id AND cc._status = 'published'
WHERE a._status = 'published'
OFFSET 0;

CREATE VIEW article_sections AS
SELECT
  a.article_id,
  (s._order - 1)::integer AS position,
  s.heading,
  s.body,
  ic.catalog_id AS image_catalog_id,
  s.image_caption
FROM articles_sections s
JOIN articles a ON a.id = s._parent_id
LEFT JOIN catalogs ic ON ic.id = s.image_catalog_id AND ic._status = 'published'
WHERE a._status = 'published'
OFFSET 0;

CREATE VIEW article_citations AS
SELECT a.article_id, (c._order - 1)::integer AS position, c.text, c.url
FROM articles_citations c
JOIN articles a ON a.id = c._parent_id
WHERE a._status = 'published'
OFFSET 0;

CREATE VIEW article_collection_entries AS
SELECT
  k.collection_id,
  k.title,
  k.subtitle,
  k.summary,
  k.category,
  k.issue,
  cc.catalog_id AS cover_catalog_id,
  k.revision::integer AS revision,
  k.first_published_at,
  k.published_at,
  k.updated_at
FROM article_collections k
LEFT JOIN catalogs cc ON cc.id = k.cover_catalog_id AND cc._status = 'published'
WHERE k._status = 'published'
OFFSET 0;

CREATE VIEW article_collection_members AS
SELECT
  k.collection_id,
  (m._order - 1)::integer AS position,
  m.kind::text AS kind,
  a.article_id,
  m.catalog_id
FROM article_collections_members m
JOIN article_collections k ON k.id = m._parent_id
LEFT JOIN articles a ON a.id = m.article_id AND a._status = 'published'
WHERE k._status = 'published'
OFFSET 0;
`;

export const dropPublishedArticleViewsSql = `
DROP VIEW article_collection_members;
DROP VIEW article_collection_entries;
DROP VIEW article_citations;
DROP VIEW article_sections;
DROP VIEW article_entries;
`;
