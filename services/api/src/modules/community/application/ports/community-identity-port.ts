import type { PublicUserId } from "@moya/contracts";

import type { PublicUserRecord } from "../../domain/public-user.js";
import type {
  CommandReceipt,
  ModerationEventDraft,
} from "./community-comment-port.js";

/** A session row as the Backend stores it: the raw token never reaches the port. */
export interface SessionRecordInput {
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: PublicUserId;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** Application-owned identity and session port for the community namespace. */
export interface CommunityIdentityPort {
  /** Only accounts registered as Development test accounts resolve here. */
  findDevelopmentAccountByHandle(
    handle: string,
  ): Promise<PublicUserRecord | null>;

  createSession(session: SessionRecordInput): Promise<void>;

  /** The user behind an unrevoked session that has not expired at `now`. */
  findSessionUser(
    tokenHash: string,
    now: Date,
  ): Promise<PublicUserRecord | null>;

  /** Revokes an active session; false when no active session matched. */
  revokeSession(tokenHash: string, now: Date): Promise<boolean>;

  /**
   * Suspension refuses new writes and revokes the user's active sessions in one
   * transaction; it changes no comment's moderation state. Null when unknown.
   * When `audit` is given, its moderation event is written in that same
   * transaction, and only when the status actually changed: a repeated
   * transition returns the unchanged user and records nothing. A deleted
   * account is terminal: nothing is written and the unchanged user (status
   * `deleted`) is returned. `receipt` is the AI path's: it commits in the same
   * transaction, an unchanged status included, so a repeat of the command answers
   * what it stored and changes nothing, even after someone else undid its effect.
   */
  setUserStatus(
    id: PublicUserId,
    status: Exclude<PublicUserRecord["status"], "deleted">,
    at: Date,
    audit?: ModerationEventDraft,
    receipt?: CommandReceipt,
  ): Promise<{
    readonly user: Pick<PublicUserRecord, "id" | "status">;
    readonly revokedSessions: number;
    /** The account was already in this status, so nothing was recorded. */
    readonly unchanged?: true;
    /** This command's receipt answered, so nothing ran. */
    readonly replayed?: true;
  } | null>;
}
