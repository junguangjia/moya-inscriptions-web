-- Explicit post-Payload-migration runtime grants. Execute with psql -v
-- cms_role=<pre-provisioned-role>, ON_ERROR_STOP and --single-transaction.
-- The runtime must be distinct from the migration owner. This script never
-- creates roles, changes credentials, transfers ownership or grants future tables.
SELECT set_config('moya.cms_runtime_role', :'cms_role', true);
DO $$
DECLARE target text := current_setting('moya.cms_runtime_role');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=target
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication)
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='public'
      AND (pg_has_role(target,nspowner,'USAGE') OR pg_has_role(target,nspowner,'SET')))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','community') AND (pg_has_role(target,c.relowner,'USAGE') OR pg_has_role(target,c.relowner,'SET')))
    OR has_schema_privilege(target,'public','CREATE') THEN
    RAISE EXCEPTION 'CMS runtime must be a non-owner role without persistent DDL authority';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO :"cms_role";

-- Existing hard-delete-disabled root collections still support creation/editing.
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.article_collections,
  public.articles,
  public.catalogs,
  public.editorial_approvals,
  public.editorial_article_approvals,
  public.media,
  public.users
TO :"cms_role";

-- Identity claims and completed receipts are append-only in existing application code.
GRANT SELECT, INSERT ON TABLE
  public.editorial_identities,
  public.editorial_receipts
TO :"cms_role";

-- Payload updates replace array/relationship rows; maxPerDoc prunes retained versions;
-- native sessions, document locks/preferences and existing API-key management delete rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public._article_collections_v,
  public._article_collections_v_version_members,
  public._articles_v,
  public._articles_v_version_citations,
  public._articles_v_version_sections,
  public._catalogs_v,
  public._catalogs_v_version_aliases,
  public._catalogs_v_version_contributors,
  public._catalogs_v_version_media,
  public._catalogs_v_version_provenance,
  public._catalogs_v_version_source_citations,
  public._catalogs_v_version_source_citations_applies_to,
  public.article_collections_members,
  public.articles_citations,
  public.articles_sections,
  public.catalogs_aliases,
  public.catalogs_contributors,
  public.catalogs_media,
  public.catalogs_provenance,
  public.catalogs_source_citations,
  public.catalogs_source_citations_applies_to,
  public.editorial_approvals_items,
  public.editorial_article_approvals_items,
  public.payload_kv,
  public.payload_locked_documents,
  public.payload_locked_documents_rels,
  public.payload_mcp_api_keys,
  public.payload_preferences,
  public.payload_preferences_rels,
  public.users_sessions
TO :"cms_role";

-- Derived search is synchronized on publish/withdraw; first-publication is insert-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.catalog_search_documents
TO :"cms_role";
GRANT SELECT, INSERT ON TABLE
  public.catalog_first_publications
TO :"cms_role";

-- Published projections support existing CMS search/detail checks without owning views.
GRANT SELECT ON TABLE
  public.article_citations,
  public.article_collection_entries,
  public.article_collection_members,
  public.article_entries,
  public.article_sections,
  public.catalog_aliases,
  public.catalog_contributors,
  public.catalog_discovery,
  public.catalog_entries,
  public.catalog_media,
  public.catalog_source_citation_scopes,
  public.catalog_source_citations
TO :"cms_role";

-- Readiness may inspect committed migration names; no DML on the ledger.
GRANT SELECT (name) ON public.payload_migrations TO :"cms_role";

-- nextval/currval only on the named non-ledger serial sequences; no setval.
GRANT USAGE ON SEQUENCE
  public._article_collections_v_id_seq,
  public._article_collections_v_version_members_id_seq,
  public._articles_v_id_seq,
  public._articles_v_version_citations_id_seq,
  public._articles_v_version_sections_id_seq,
  public._catalogs_v_id_seq,
  public._catalogs_v_version_aliases_id_seq,
  public._catalogs_v_version_contributors_id_seq,
  public._catalogs_v_version_media_id_seq,
  public._catalogs_v_version_provenance_id_seq,
  public._catalogs_v_version_source_citations_applies_to_id_seq,
  public._catalogs_v_version_source_citations_id_seq,
  public.article_collections_id_seq,
  public.articles_id_seq,
  public.catalogs_id_seq,
  public.catalogs_source_citations_applies_to_id_seq,
  public.editorial_approvals_id_seq,
  public.editorial_article_approvals_id_seq,
  public.editorial_identities_id_seq,
  public.editorial_receipts_id_seq,
  public.media_id_seq,
  public.payload_kv_id_seq,
  public.payload_locked_documents_id_seq,
  public.payload_locked_documents_rels_id_seq,
  public.payload_mcp_api_keys_id_seq,
  public.payload_preferences_id_seq,
  public.payload_preferences_rels_id_seq,
  public.users_id_seq
TO :"cms_role";

-- No application-defined SQL function is called by the CMS runtime.
-- Existing editorial transaction fencing calls pg_catalog.pg_advisory_xact_lock
-- and pg_catalog.hashtextextended, supplied by PostgreSQL itself.
