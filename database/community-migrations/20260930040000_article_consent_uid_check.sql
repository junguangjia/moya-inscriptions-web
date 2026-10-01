-- Forward correction: PostgreSQL ARE repetition bounds stop at 255.
-- Keep the existing ASCII interaction identity and 256-character contract.
-- Applied delegation migration bytes and stored identities remain unchanged.
ALTER TABLE community.article_authoring_consents
  DROP CONSTRAINT article_authoring_consents_interaction_uid_check,
  ADD CONSTRAINT article_authoring_consents_interaction_uid_check CHECK (
    char_length(interaction_uid) BETWEEN 1 AND 256
    AND interaction_uid ~ '^[A-Za-z0-9_-]+$'
  );
