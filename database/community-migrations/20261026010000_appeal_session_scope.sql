-- Restricted appeal sessions cannot cross the normal community identity boundary.
ALTER TABLE community.sessions ADD COLUMN scope text NOT NULL DEFAULT 'community'
  CHECK (scope IN ('community','appeal'));

-- Only a coarse label and observation time are stored in the public profile projection.
CREATE TABLE community.profile_ip_locations (
 user_id text PRIMARY KEY REFERENCES community.public_users(id),
 label text CHECK (char_length(label) BETWEEN 1 AND 100),
 observed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
