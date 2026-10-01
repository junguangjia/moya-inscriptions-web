import type { createPostgresPool } from "@moya/catalog-postgres";
import { requireSyntheticTestDatabaseUrl } from "./synthetic-test-database.js";

/** Remove only a disposable fixture's actor/recipient notification references. */
export const cleanupNotificationData = async (
  pool: ReturnType<typeof createPostgresPool>,
  users: readonly string[],
): Promise<void> => {
  requireSyntheticTestDatabaseUrl();
  const ids = [...users];
  await pool.query(
    `DELETE FROM community.notification_deliveries
     WHERE recipient_id=ANY($1::text[]) OR action_key IN (
       SELECT action_key FROM community.notification_sources WHERE actor_id=ANY($1::text[]))`,
    [ids],
  );
  await pool.query(
    "DELETE FROM community.notification_groups WHERE recipient_id=ANY($1::text[])",
    [ids],
  );
  await pool.query(
    "DELETE FROM community.notification_recipient_versions WHERE recipient_id=ANY($1::text[])",
    [ids],
  );
  await pool.query(
    "DELETE FROM community.notification_sources WHERE actor_id=ANY($1::text[])",
    [ids],
  );
};
