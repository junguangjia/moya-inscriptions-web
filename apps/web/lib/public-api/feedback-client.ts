import type { SubmitFeedbackRequest } from "@moya/contracts";
import {
  feedbackReceiptSchema,
  submitFeedbackRequestSchema,
} from "@moya/contracts/schemas";
export { FEEDBACK_IMAGE_LIMITS as feedbackImageLimits } from "@moya/contracts/schemas";
import { authorRequest } from "./author-community-client";

/** Reuse the same-origin relay, confirmed account and Backend-owned session. */
export const feedbackClient = {
  submit: (input: SubmitFeedbackRequest, signal?: AbortSignal) =>
    authorRequest("feedback", feedbackReceiptSchema, {
      method: "POST",
      body: submitFeedbackRequestSchema.parse(input),
      ...(signal ? { signal } : {}),
    }),
};
