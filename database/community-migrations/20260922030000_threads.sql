-- content-community-completion-v1 (track C): operator-managed Threads as an
-- association over the existing Work domain. A Thread post IS a
-- community.works row; this file adds no second author/text/media store.
CREATE TABLE community.threads (
  id TEXT PRIMARY KEY CHECK (id ~ '^thread-[0-9a-f]{32}$'),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  -- Bounded presentation tags only; not a taxonomy.
  tags TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 6),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  hidden_at TIMESTAMPTZ,
  -- Operator ordering hint among Threads; ranking uses heat first.
  position INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX threads_visible_idx ON community.threads(position, created_at DESC, id)
  WHERE hidden_at IS NULL;

-- One Work belongs to at most one Thread (UNIQUE work_id); real FKs both ways.
CREATE TABLE community.thread_works (
  thread_id TEXT NOT NULL REFERENCES community.threads(id),
  work_id TEXT NOT NULL UNIQUE REFERENCES community.works(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, work_id)
);
CREATE INDEX thread_works_order_idx ON community.thread_works(thread_id, created_at DESC, work_id DESC);

-- Per-user observed activity marker; server-clamped, never client-supplied.
CREATE TABLE community.thread_read_state (
  user_id TEXT NOT NULL REFERENCES community.public_users(id),
  thread_id TEXT NOT NULL REFERENCES community.threads(id),
  observed_activity_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, thread_id)
);
