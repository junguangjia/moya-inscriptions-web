-- admin-mcp-completion-v1 (Issue #355, login door): the `operator` preset, and
-- the function that keeps the consent table from growing without bound.
-- Forward-only; no data change. Amendment 2026-11-05, section 5.
--
-- `operator` is what an administrator grants by signing in: the tool acts as the
-- one `ai_operator` row at the full tool profile. The frozen preset on a grant
-- and on a consent has to be able to say so, and the connection carries it.
ALTER TABLE community.agent_connections
  DROP CONSTRAINT agent_connections_preset_check,
  ADD CONSTRAINT agent_connections_preset_check
    CHECK (preset IN ('read-only', 'management', 'operator'));

ALTER TABLE community.agent_connection_grants
  DROP CONSTRAINT agent_connection_grants_preset_at_consent_check,
  ADD CONSTRAINT agent_connection_grants_preset_at_consent_check
    CHECK (preset_at_consent IN ('read-only', 'management', 'operator'));

ALTER TABLE community.agent_connection_consents
  DROP CONSTRAINT agent_connection_consents_preset_check,
  ADD CONSTRAINT agent_connection_consents_preset_check
    CHECK (preset IN ('read-only', 'management', 'operator'));

-- The r15 gate named one milestone. What it was for still holds: `management`
-- stays unreachable at the DATABASE, so no UI control or crafted request can
-- pick it, and lifting that is a later migration somebody writes on purpose.
ALTER TABLE community.agent_connection_consents
  DROP CONSTRAINT agent_connection_consents_read_only_milestone,
  ADD CONSTRAINT agent_connection_consents_reachable_presets
    CHECK (preset IN ('read-only', 'operator'));

-- An anonymous authorize request writes a row and client ids are public, so a
-- public issuer needs these gone. Only a row nobody decided, a full day past
-- its deadline: a decision is the ledger and is kept. Fixed and bounded, so the
-- provider role can run it and still holds no DELETE on the table.
CREATE FUNCTION community.agent_connection_consents_reap(max_rows INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, community
AS $function$
DECLARE
  reaped INTEGER;
BEGIN
  IF max_rows IS NULL OR max_rows NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'max_rows must be between 1 and 10000'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Materialized, so the limit is the bound: a planner that rescans a LIMIT
  -- subquery on the inner side of a join can delete more rows than it names.
  WITH doomed AS MATERIALIZED (
    SELECT interaction_uid FROM community.agent_connection_consents
     WHERE decided_at IS NULL
       AND expires_at < CURRENT_TIMESTAMP - INTERVAL '1 day'
     ORDER BY expires_at
     LIMIT max_rows
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM community.agent_connection_consents consent
   USING doomed
   WHERE consent.interaction_uid = doomed.interaction_uid;
  GET DIAGNOSTICS reaped = ROW_COUNT;
  RETURN reaped;
END;
$function$;
REVOKE ALL ON FUNCTION community.agent_connection_consents_reap(INTEGER) FROM PUBLIC;
