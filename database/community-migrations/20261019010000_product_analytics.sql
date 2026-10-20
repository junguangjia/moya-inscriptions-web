-- First-party analytics; raw source IP is isolated and expires after seven days.
CREATE TABLE community.analytics_ip_observations (
  id UUID PRIMARY KEY,
  visitor_id UUID NOT NULL,
  user_id TEXT,
  ip INET NOT NULL,
  user_agent VARCHAR(512) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at = received_at + INTERVAL '7 days')
);
CREATE INDEX analytics_ip_expiry ON community.analytics_ip_observations (expires_at);
CREATE INDEX analytics_ip_recent ON community.analytics_ip_observations (received_at DESC);

CREATE TABLE community.analytics_events (
  event_id UUID PRIMARY KEY,
  visitor_id UUID NOT NULL,
  session_id UUID NOT NULL,
  user_id TEXT,
  distinct_id VARCHAR(40) NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name IN ('page_view','content_impression','content_open','content_dwell','search','search_click','like','favorite','follow')),
  target_type TEXT CHECK (target_type IN ('catalog','work','article','profile')),
  target_id VARCHAR(128),
  surface TEXT NOT NULL CHECK (surface IN ('home','browse','search','detail','profile','thread','other')),
  event_data JSONB NOT NULL CHECK (jsonb_typeof(event_data) = 'object' AND octet_length(event_data::text) <= 4096),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  forwarded_at TIMESTAMPTZ,
  CHECK ((target_type IS NULL) = (target_id IS NULL))
);
CREATE INDEX analytics_events_received ON community.analytics_events (received_at, event_id);
CREATE INDEX analytics_events_actor_time ON community.analytics_events (user_id, occurred_at) WHERE user_id IS NOT NULL;
CREATE INDEX analytics_events_target_time ON community.analytics_events (target_type, target_id, occurred_at);
CREATE INDEX analytics_events_forwarded ON community.analytics_events (forwarded_at DESC) WHERE forwarded_at IS NOT NULL;

CREATE TABLE community.analytics_outbox (
  event_id UUID PRIMARY KEY REFERENCES community.analytics_events (event_id) ON DELETE CASCADE,
  observation_id UUID REFERENCES community.analytics_ip_observations (id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  failed_at TIMESTAMPTZ
);
CREATE INDEX analytics_outbox_due ON community.analytics_outbox (next_attempt_at) WHERE failed_at IS NULL;
CREATE INDEX analytics_outbox_observation ON community.analytics_outbox (observation_id);
