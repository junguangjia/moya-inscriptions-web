import type {
  DirectConversation,
  DirectConversationPage,
  DirectMessage,
  DirectMessagePage,
  DirectMessageUnread,
  DmConversationId,
  DmMessageId,
} from "@moya/contracts";
import type {
  OperatorDmConversation,
  OperatorDmMessage,
} from "@moya/contracts/internal/community-operator";

export interface DirectMessageSendInput {
  readonly requestId: string;
  readonly recipientId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly text: string;
}

/**
 * content-community-completion-v1: one-to-one direct messages. Every
 * operation verifies membership, account status and blocking on the Backend;
 * the sender is always the Session account. Commands are receipted under
 * (actor, requestId): an identical retry replays, a different command under
 * the same identity conflicts. The adapter serializes pair creation, first
 * send, recipient reply and participant changes with a per-pair transaction
 * lock, and rechecks permission after the lock wait.
 */
export interface DirectMessagePort {
  send(actor: string, input: DirectMessageSendInput): Promise<DirectMessage>;
  listConversations(
    actor: string,
    query: { cursor?: string | undefined; pageSize: number },
  ): Promise<DirectConversationPage>;
  readConversation(
    actor: string,
    id: DmConversationId,
    query: {
      before?: number | undefined;
      after?: number | undefined;
      pageSize: number;
    },
  ): Promise<DirectMessagePage>;
  /** Resolves (never creates) the canonical conversation with another account, for a profile entry. */
  findConversationWith(
    actor: string,
    otherId: string,
  ): Promise<DirectConversation | null>;
  setHidden(
    actor: string,
    id: DmConversationId,
    hidden: boolean,
    requestId: string,
  ): Promise<DirectConversation>;
  setMuted(
    actor: string,
    id: DmConversationId,
    muted: boolean,
    requestId: string,
  ): Promise<DirectConversation>;
  markRead(
    actor: string,
    id: DmConversationId,
    sequence: number,
    requestId: string,
  ): Promise<DirectConversation>;
  unread(actor: string): Promise<DirectMessageUnread>;
  // Owner-only moderation over one explicitly selected conversation.
  operatorReadConversation(
    operator: string,
    id: string,
    purpose: string,
  ): Promise<OperatorDmConversation>;
  operatorFindConversation(
    operator: string,
    userIds: readonly [string, string],
    purpose: string,
  ): Promise<OperatorDmConversation | null>;
  operatorRemoveMessage(
    operator: string,
    id: DmMessageId,
    requestId: string,
    purpose: string,
  ): Promise<OperatorDmMessage>;
}
