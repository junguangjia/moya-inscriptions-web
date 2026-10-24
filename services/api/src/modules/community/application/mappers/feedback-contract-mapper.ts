import { submitFeedbackRequestSchema } from "@moya/contracts/schemas";
import { CommunityInputError } from "../errors/community-request-errors.js";
import type { SubmitFeedbackRequest } from "@moya/contracts";

export const parseFeedbackSubmission = (
  input: unknown,
): SubmitFeedbackRequest => {
  const parsed = submitFeedbackRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new CommunityInputError("Invalid feedback request");
  return parsed.data;
};
