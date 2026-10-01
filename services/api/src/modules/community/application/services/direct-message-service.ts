import {
  adminRemoveDmMessageRequestSchema,
  operatorDmLookupRequestSchema,
  operatorDmReadRequestSchema,
} from "@moya/contracts/internal/community-operator";

import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../errors/community-request-errors.js";
import {
  parseDmConversationId,
  parseDmMessageId,
} from "../mappers/direct-message-contract-mapper.js";

import type {
  DirectMessagePort,
  DirectMessageSendInput,
} from "../ports/direct-message-port.js";

/**
 * Application boundary for direct messages. The adapter owns the pair lock,
 * the request gate, the receipts and the anti-abuse limits; the service only
 * shapes identities and never derives a sender from input.
 */
export class DirectMessageService {
  constructor(private readonly port: DirectMessagePort) {}

  private conversation(value: string) {
    const parsed = parseDmConversationId(value);
    if (parsed === null) throw new CommunityNotFoundError();
    return parsed;
  }

  private static command<T>(
    schema: {
      safeParse(
        value: unknown,
      ): { success: true; data: T } | { success: false };
    },
    input: unknown,
  ): T {
    const result = schema.safeParse(input);
    if (!result.success) throw new CommunityInputError();
    return result.data;
  }

  send(actor: string, input: DirectMessageSendInput) {
    return this.port.send(actor, input);
  }
  list(
    actor: string,
    query: { cursor?: string | undefined; pageSize: number },
  ) {
    return this.port.listConversations(actor, query);
  }
  read(
    actor: string,
    id: string,
    query: {
      before?: number | undefined;
      after?: number | undefined;
      pageSize: number;
    },
  ) {
    return this.port.readConversation(actor, this.conversation(id), query);
  }
  with(actor: string, otherId: string) {
    return this.port.findConversationWith(actor, otherId);
  }
  hide(actor: string, id: string, hidden: boolean, requestId: string) {
    return this.port.setHidden(actor, this.conversation(id), hidden, requestId);
  }
  mute(actor: string, id: string, muted: boolean, requestId: string) {
    return this.port.setMuted(actor, this.conversation(id), muted, requestId);
  }
  markRead(actor: string, id: string, sequence: number, requestId: string) {
    return this.port.markRead(
      actor,
      this.conversation(id),
      sequence,
      requestId,
    );
  }
  unread(actor: string) {
    return this.port.unread(actor);
  }
  /** Operator requests arrive untrusted; the operator Contracts decide their shape. */
  operatorRead(operator: string, input: unknown) {
    const request = DirectMessageService.command(
      operatorDmReadRequestSchema,
      input,
    );
    return this.port.operatorReadConversation(
      operator,
      request.id,
      request.purpose,
    );
  }
  operatorFind(operator: string, input: unknown) {
    const request = DirectMessageService.command(
      operatorDmLookupRequestSchema,
      input,
    );
    return this.port.operatorFindConversation(
      operator,
      [request.userIds[0]!, request.userIds[1]!],
      request.purpose,
    );
  }
  operatorRemove(operator: string, id: string, input: unknown) {
    const messageId = parseDmMessageId(id);
    if (messageId === null) throw new CommunityNotFoundError();
    const request = DirectMessageService.command(
      adminRemoveDmMessageRequestSchema,
      {
        ...(typeof input === "object" && input !== null ? input : {}),
        id: messageId,
      },
    );
    return this.port.operatorRemoveMessage(
      operator,
      messageId,
      request.requestId,
      request.purpose,
    );
  }
}
