import type { PublicUserId } from "@moya/contracts";

/**
 * `deleted` (account-deletion-v1) is terminal: the row stays as an anonymized
 * tombstone, and its Sessions identify as signed out.
 */
export type PublicUserStatus = "active" | "suspended" | "deleted";

/** Internal public-user record. It is neither a Public DTO nor a persistence row. */
export interface PublicUserRecord {
  readonly id: PublicUserId;
  readonly handle: string;
  readonly displayName: string;
  readonly studioName?: string;
  readonly status: PublicUserStatus;
}
