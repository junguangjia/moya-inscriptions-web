-- messaging-notification-foundation-v1. No historical interaction backfill.
ALTER TABLE community.catalog_comments ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mentions)='array' AND jsonb_array_length(mentions)<=20);
ALTER TABLE community.catalog_comment_replies ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mentions)='array' AND jsonb_array_length(mentions)<=20);
ALTER TABLE community.work_revisions ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mentions)='array' AND jsonb_array_length(mentions)<=20);

CREATE TABLE community.notification_sources (
  action_key text PRIMARY KEY CHECK (length(action_key)<=300),
  kind text NOT NULL CHECK (kind IN ('work_like','comment_like','comment','work_mention')),
  subject_id text NOT NULL,
  actor_id text NOT NULL REFERENCES community.public_users(id),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation>0),
  completed_generation bigint NOT NULL DEFAULT 0 CHECK (completed_generation>=0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  run_after timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner text,
  lease_until timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code='projection_failed'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((lease_owner IS NULL)=(lease_until IS NULL))
);
CREATE INDEX notification_sources_ready ON community.notification_sources(run_after, action_key) WHERE completed_generation<generation AND attempts<5;
CREATE INDEX notification_sources_subject ON community.notification_sources(subject_id);
CREATE TABLE community.notification_recipient_versions (
  recipient_id text PRIMARY KEY REFERENCES community.public_users(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0)
);
CREATE TABLE community.notification_groups (
  id text PRIMARY KEY CHECK (id ~ '^notification-[0-9a-f]{32}$'),
  recipient_id text NOT NULL REFERENCES community.public_users(id),
  group_key text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('like','comment','reply','mention')),
  read_through bigint NOT NULL DEFAULT 0 CHECK (read_through>=0),
  UNIQUE (recipient_id, group_key),
  UNIQUE (id, recipient_id)
);
CREATE TABLE community.notification_deliveries (
  action_key text NOT NULL REFERENCES community.notification_sources(action_key),
  recipient_id text NOT NULL REFERENCES community.public_users(id),
  group_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  reasons text[] NOT NULL CHECK (cardinality(reasons) BETWEEN 1 AND 3),
  delivered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (action_key, recipient_id),
  UNIQUE (recipient_id, revision),
  FOREIGN KEY (group_id, recipient_id) REFERENCES community.notification_groups(id, recipient_id)
);
CREATE INDEX notification_deliveries_history ON community.notification_deliveries(recipient_id, revision DESC);
CREATE INDEX notification_deliveries_group ON community.notification_deliveries(group_id, revision DESC);
