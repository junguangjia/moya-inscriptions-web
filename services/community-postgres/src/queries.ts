export const findDevelopmentAccountByHandleSql = `
  SELECT u.id, u.handle, u.display_name, u.studio_name, u.status
  FROM community.public_users u
  JOIN community.development_accounts d ON d.user_id = u.id
  WHERE u.handle = $1::text
`;

export const insertSessionSql = `
  INSERT INTO community.sessions (id, token_hash, user_id, issued_at, expires_at)
  VALUES ($1::text, $2::text, $3::text, $4::timestamptz, $5::timestamptz)
`;

export const findSessionUserSql = `
  SELECT u.id, u.handle, u.display_name, u.studio_name, u.status
  FROM community.sessions s
  JOIN community.public_users u ON u.id = s.user_id
  WHERE s.token_hash = $1::text
    AND s.revoked_at IS NULL
    AND s.expires_at > $2::timestamptz
    AND (NOT $3::boolean OR (s.issuer = 'verified_login' AND s.auth_environment = 'production'))
`;

export const revokeSessionSql = `
  UPDATE community.sessions
  SET revoked_at = $2::timestamptz
  WHERE token_hash = $1::text
    AND revoked_at IS NULL
    AND expires_at > $2::timestamptz
`;
