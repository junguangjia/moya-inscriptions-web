-- Preserve every legacy combined studio name; new editors record their suffix.
ALTER TABLE community.public_users ADD COLUMN studio_name_suffix TEXT NOT NULL DEFAULT '';
ALTER TABLE community.public_users DROP CONSTRAINT public_users_studio_name_valid;
ALTER TABLE community.public_users ADD CONSTRAINT public_users_studio_name_valid
  CHECK (char_length(studio_name) <= 7 AND studio_name = btrim(studio_name));
ALTER TABLE community.public_users ADD CONSTRAINT public_users_studio_name_pair_valid
  CHECK (
    (studio_name_suffix = '' AND char_length(studio_name) <= 6)
    OR (
      char_length(studio_name_suffix) BETWEEN 1 AND 2
      AND studio_name_suffix = btrim(studio_name_suffix)
      AND right(studio_name, char_length(studio_name_suffix)) = studio_name_suffix
      AND char_length(studio_name) - char_length(studio_name_suffix) BETWEEN 1 AND 5
      AND left(studio_name, char_length(studio_name) - char_length(studio_name_suffix)) =
          btrim(left(studio_name, char_length(studio_name) - char_length(studio_name_suffix)))
    )
  );
