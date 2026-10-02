import type { PublicUserId } from "@moya/contracts";

export type PublicUserStatus = "active" | "suspended";

/** Internal public-user record. It is neither a Public DTO nor a persistence row. */
export interface PublicUserRecord {
  readonly id: PublicUserId;
  readonly handle: string;
  readonly displayName: string;
  readonly studioName?: string;
  readonly status: PublicUserStatus;
}
