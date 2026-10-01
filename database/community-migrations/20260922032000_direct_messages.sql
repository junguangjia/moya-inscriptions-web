-- content-community-completion-v1 (track C): one-to-one plain-text direct
-- messages. One canonical conversation per unordered pair (user_low <
-- user_high, UNIQUE); participant state is separate from message facts;
-- messages are immutable with a server-allocated per-conversation sequence.
-- The request gate: a conversation is 'requested' until the recipient's
-- committed non-empty reply makes it 'active'.
CREATE TABLE community.dm_conversations (
  id TEXT PRIMARY KEY CHECK (id ~ '^dm-[0-9a-f]{32}$'),
  user_low TEXT NOT NULL REFERENCES community.public_users(id),
  user_high TEXT NOT NULL REFERENCES community.public_users(id),
  initiator_id TEXT NOT NULL REFERENCES community.public_users(id),
  state TEXT NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','active')),
  next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (user_low < user_high),
  CHECK (initiator_id IN (user_low, user_high)),
  UNIQUE (user_low, user_high)
);
-- Daily initiation limit counts conversations an account opened per UTC day.
CREATE INDEX dm_conversations_initiator_idx ON community.dm_conversations(initiator_id, created_at DESC);

CREATE TABLE community.dm_participants (
  conversation_id TEXT NOT NULL REFERENCES community.dm_conversations(id),
  user_id TEXT NOT NULL REFERENCES community.public_users(id),
  -- Hide-for-self; a newer eligible message than hidden_before_sequence resurfaces it.
  hidden_at TIMESTAMPTZ,
  hidden_before_sequence BIGINT NOT NULL DEFAULT 0,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  -- Monotonic observed message sequence; never a public read receipt.
  read_sequence BIGINT NOT NULL DEFAULT 0 CHECK (read_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX dm_participants_user_idx ON community.dm_participants(user_id, conversation_id);

CREATE TABLE community.dm_messages (
  id TEXT PRIMARY KEY CHECK (id ~ '^dmsg-[0-9a-f]{32}$'),
  conversation_id TEXT NOT NULL REFERENCES community.dm_conversations(id),
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  sender_id TEXT NOT NULL REFERENCES community.public_users(id),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Removal by the authorized moderation path only; the row and sequence stay.
  removed_at TIMESTAMPTZ,
  removed_by TEXT,
  UNIQUE (conversation_id, sequence)
);
CREATE INDEX dm_messages_sender_rate_idx ON community.dm_messages(sender_id, created_at DESC);

-- Domain-local command receipts: an identical retry replays its committed
-- result; a different command under the same identity conflicts.
CREATE TABLE community.dm_command_receipts (
  actor_id TEXT NOT NULL REFERENCES community.public_users(id),
  request_id UUID NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_id, request_id)
);

-- Content-free audit of Owner access and actions on private messages.
CREATE TABLE community.dm_moderation_events (
  id UUID PRIMARY KEY,
  operator_label TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('read_conversation','remove_message')),
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  purpose TEXT NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX dm_moderation_events_conversation_idx ON community.dm_moderation_events(conversation_id, created_at DESC);
