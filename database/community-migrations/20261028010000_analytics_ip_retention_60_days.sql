-- Allow the previous writer during the Admin-first, Backend-second rollout.
ALTER TABLE community.analytics_ip_observations
  DROP CONSTRAINT analytics_ip_observations_check;
ALTER TABLE community.analytics_ip_observations
  ADD CONSTRAINT analytics_ip_observations_retention_check
  CHECK (
    expires_at = received_at + INTERVAL '7 days'
    OR expires_at = received_at + INTERVAL '60 days'
  );

-- Extend only still-active legacy observations; never revive expired records.
UPDATE community.analytics_ip_observations
SET expires_at = received_at + INTERVAL '60 days'
WHERE expires_at > CURRENT_TIMESTAMP
  AND expires_at = received_at + INTERVAL '7 days';
