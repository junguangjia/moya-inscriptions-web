-- Run only after local Payload migrations; no access to drafts/users/MCP receipts.
GRANT SELECT ON TABLE
  public.catalog_entries,
  public.catalog_aliases,
  public.catalog_contributors,
  public.catalog_source_citations,
  public.catalog_source_citation_scopes,
  public.catalog_media,
  public.catalog_search_documents
TO yoyi_dev_public;

-- content-community-completion-v1: published-only editorial content views.
GRANT SELECT ON TABLE
  public.article_entries,
  public.article_sections,
  public.article_citations,
  public.article_collection_entries,
  public.article_collection_members
TO yoyi_dev_public;

-- Readiness checks only migration names, never the complete CMS ledger.
GRANT SELECT (name) ON TABLE public.payload_migrations TO yoyi_dev_public;
