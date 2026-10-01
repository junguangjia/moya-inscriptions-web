import type {
  MentionLookupPage,
  NotificationItem,
  NotificationUnread,
} from "@moya/contracts";

export type NotificationFilter = "all" | "likes" | "comments" | "mentions";
export interface NotificationQuery {
  readonly highWater?: string;
  readonly before?: string;
  readonly filter: NotificationFilter;
  readonly limit: number;
}
export interface NotificationStoredItem extends Omit<
  NotificationItem,
  "observation"
> {
  readonly revision: string;
}
export interface NotificationReadResult {
  readonly highWater: string;
  readonly items: readonly NotificationStoredItem[];
  readonly unread: NotificationUnread;
  readonly hasMore: boolean;
}
export interface NotificationPort {
  read(
    recipient: string,
    query: NotificationQuery,
  ): Promise<NotificationReadResult>;
  markRead(recipient: string, through: string, groupId?: string): Promise<void>;
  lookup(actor: string, query: string): Promise<MentionLookupPage>;
}
export interface NotificationJobClaim {
  readonly actionKey: string;
  readonly generation: string;
  readonly leaseOwner: string;
}
export interface NotificationWorkerPort {
  claim(owner: string, limit: number): Promise<readonly NotificationJobClaim[]>;
  project(claim: NotificationJobClaim): Promise<readonly string[]>;
  fail(claim: NotificationJobClaim): Promise<void>;
}
