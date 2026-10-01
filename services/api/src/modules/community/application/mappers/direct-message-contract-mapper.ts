import {
  dmConversationIdSchema,
  dmMessageIdSchema,
} from "@moya/contracts/schemas";

import type { DmConversationId, DmMessageId } from "@moya/contracts";

/** A DM conversation id from an untrusted path segment, or null. */
export const parseDmConversationId = (
  value: string,
): DmConversationId | null => {
  const parsed = dmConversationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** A DM message id from an untrusted path segment, or null. */
export const parseDmMessageId = (value: string): DmMessageId | null => {
  const parsed = dmMessageIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
