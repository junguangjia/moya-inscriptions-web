-- The existing approved internal reader may receive the two private views:
-- catalog_delivery_prepare_media and, from CMS migration 20261024_000000
-- (catalog-scale-v1 M2), catalog_delivery_live_prepare_media, which the
-- worker's complete snapshot reads. Re-run after that migration and before
-- deploying a worker that reads it; an absent view is a hard failure.
-- Apply only after the CMS migration with all four explicit identity inputs:
-- prepare_reader, approved_prepare_reader, public_read_role, backend_read_role.
-- All identify existing roles; the approved target comes from the separate
-- reviewed configuration package. Never point it at the shared public reader.
-- Use --single-transaction. This neither creates an identity nor grants any
-- public/media master table, writable relation, or future object privilege.
SELECT set_config('moya.catalog_prepare_reader', :'prepare_reader', true);
SELECT set_config('moya.catalog_approved_prepare_reader', :'approved_prepare_reader', true);
SELECT set_config('moya.catalog_public_read_role', :'public_read_role', true);
SELECT set_config('moya.catalog_backend_read_role', :'backend_read_role', true);
DO $$
DECLARE target text := current_setting('moya.catalog_prepare_reader');
BEGIN
  IF target <> current_setting('moya.catalog_approved_prepare_reader')
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('moya.catalog_public_read_role'))
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('moya.catalog_backend_read_role'))
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication)
    OR EXISTS (SELECT 1 FROM pg_roles r CROSS JOIN pg_roles p
      WHERE p.rolname = target AND r.rolname IN
      (current_setting('moya.catalog_public_read_role'), current_setting('moya.catalog_backend_read_role'))
      AND (p.oid = r.oid
        OR pg_has_role(p.oid, r.oid, 'USAGE') OR pg_has_role(p.oid, r.oid, 'SET')
        OR pg_has_role(r.oid, p.oid, 'USAGE') OR pg_has_role(r.oid, p.oid, 'SET')))
    OR has_schema_privilege(target, 'public', 'CREATE')
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN
        ('catalog_delivery_intents', 'catalog_delivery_receipts', 'catalog_delivery_prepare_media',
          'catalog_delivery_live_prepare_media')
        AND (pg_has_role(target, c.relowner, 'USAGE') OR pg_has_role(target, c.relowner, 'SET'))) THEN
    RAISE EXCEPTION 'Catalog prepare reader must be the approved private non-owner role, isolated from public readers';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO :"prepare_reader";
GRANT SELECT ON public.catalog_delivery_prepare_media TO :"prepare_reader";
GRANT SELECT ON public.catalog_delivery_live_prepare_media TO :"prepare_reader";
