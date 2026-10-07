import { catalogMediaDeliveryJoinSql } from "./catalog-media-delivery.js";

export const countCatalogEntriesSql = `
  SELECT COUNT(*)::text AS total
  FROM catalog_entries
  WHERE ($1::text IS NULL OR kind = $1::text)
`;

export const listCatalogEntriesSql = `
  SELECT catalog_id, kind, title, summary, period_label,
         dynasty, dynasty_state, date_text, date_text_state,
         province, province_state, prefecture, prefecture_state,
         county, county_state, current_location, current_location_state,
         current_custodian, current_custodian_state
  FROM catalog_entries
  WHERE ($1::text IS NULL OR kind = $1::text)
  ORDER BY catalog_id ASC
  LIMIT $2::integer OFFSET $3::bigint
`;

export const findCatalogEntrySql = `
  SELECT catalog_id, kind, title, summary, description, period_label,
         dynasty, dynasty_state, date_text, date_text_state,
         province, province_state, prefecture, prefecture_state,
         county, county_state, current_location, current_location_state,
         current_custodian, current_custodian_state,
         script_style, script_style_state,
         transcription, transcription_state,
         historical_context, historical_context_state,
         scholarly_research, scholarly_research_state
  FROM catalog_entries
  WHERE catalog_id = $1
`;

export const listCatalogAliasesSql = `
  SELECT catalog_id, position, alias
  FROM catalog_aliases
  WHERE catalog_id = ANY($1::text[])
  ORDER BY catalog_id ASC, position ASC
`;

export const listCatalogCitationsSql = `
  SELECT catalog_id, position, label, citation, url
  FROM catalog_source_citations
  WHERE catalog_id = $1
  ORDER BY position ASC
`;

export const listCatalogContributorsSql = `
  SELECT catalog_id, position, name, role
  FROM catalog_contributors
  WHERE catalog_id = $1
  ORDER BY position ASC
`;

export const listCatalogCitationScopesSql = `
  SELECT catalog_id, citation_position, scope
  FROM catalog_source_citation_scopes
  WHERE catalog_id = $1
  ORDER BY citation_position ASC,
           CASE scope
             WHEN 'record' THEN 1
             WHEN 'description' THEN 2
             WHEN 'transcription' THEN 3
             WHEN 'historicalContext' THEN 4
             WHEN 'scholarlyResearch' THEN 5
           END ASC
`;

export const listRepresentativeCatalogMediaSql = `
  SELECT media_id, catalog_id, position, is_representative, kind,
         alt_text, width, height, object_key
  FROM catalog_media
  WHERE catalog_id = ANY($1::text[])
    AND is_representative
  ORDER BY catalog_id ASC
`;

export const listCatalogMediaSql = `
  SELECT media_id, catalog_id, position, is_representative, kind,
         alt_text, width, height, object_key
  FROM catalog_media
  WHERE catalog_id = $1
  ORDER BY position ASC
`;

// The same media rows with their rendition delivery facts, for readers
// composed with renditions (the community schema and its read grant exist).
const catalogMediaDeliveryColumns = `
  SELECT cm.media_id, cm.catalog_id, cm.position, cm.is_representative, cm.kind,
         cm.alt_text, cm.width, cm.height, cm.object_key,
         delivery.renditions, delivery.placeholder_color
  FROM catalog_media cm${catalogMediaDeliveryJoinSql("cm")}`;

export const listRepresentativeCatalogMediaDeliverySql = `${catalogMediaDeliveryColumns}
  WHERE cm.catalog_id = ANY($1::text[])
    AND cm.is_representative
  ORDER BY cm.catalog_id ASC
`;

export const listCatalogMediaDeliverySql = `${catalogMediaDeliveryColumns}
  WHERE cm.catalog_id = $1
  ORDER BY cm.position ASC
`;
