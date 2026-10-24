import { CommunityInputError } from "../application/errors/community-request-errors.js";
import { operatorModerationReasonSchema } from "@moya/contracts/internal/community-operator";

/** Called only by the authenticated human operator HTTP boundary. */
export const requireHumanModerationReason = (input: unknown): unknown => {
  const reason = operatorModerationReasonSchema.safeParse(
    typeof input === "object" && input !== null && "reason" in input
      ? input.reason
      : undefined,
  );
  if (!reason.success)
    throw new CommunityInputError("A moderation reason is required");
  return { ...(input as Record<string, unknown>), reason: reason.data };
};
