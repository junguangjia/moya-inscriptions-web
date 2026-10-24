import type { BetaAccountAccessPort } from "@moya/contracts";
import { CommunityStoreUnavailableError } from "@moya/api";
import type { Pool } from "pg";

/** Read-only admission authority. Operator changes are visible on the next read. */
export const createPostgresBetaAccountAccess = (
  pool: Pool,
): BetaAccountAccessPort => ({
  async read(userId) {
    try {
      const result = await pool.query<{ state: "granted" | "revoked" }>(
        "SELECT state FROM community.beta_account_access WHERE user_id=$1",
        [userId],
      );
      return result.rows[0]?.state ?? "none";
    } catch (error) {
      throw new CommunityStoreUnavailableError({ cause: error });
    }
  },
});
