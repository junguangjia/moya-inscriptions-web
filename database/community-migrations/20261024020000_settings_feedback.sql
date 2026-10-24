-- settings-feedback-v1. Private, append-only feedback; no public read projection.
CREATE TABLE community.feedback (
  id text PRIMARY KEY CHECK (id ~ '^feedback-[0-9a-f]{32}$'),
  user_id text NOT NULL REFERENCES community.public_users(id),
  submission_id uuid NOT NULL,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 5000 AND message = btrim(message) AND message ~ '[^[:space:]]'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, submission_id)
);
CREATE INDEX feedback_newest ON community.feedback(created_at DESC, id DESC);
REVOKE ALL ON TABLE community.feedback FROM PUBLIC;
