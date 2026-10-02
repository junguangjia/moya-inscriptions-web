-- Preserve connection identity and consent fences while permitting the
-- explicitly composed Production surface to use its own environment.
ALTER TABLE community.article_authoring_connections
  DROP CONSTRAINT article_authoring_connections_environment_check,
  ADD CONSTRAINT article_authoring_connections_environment_check
    CHECK (environment IN ('development', 'production'));
