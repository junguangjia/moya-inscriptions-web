import type {
  FeedbackReceipt,
  FeedbackImageVariant,
  SubmitFeedbackRequest,
} from "@moya/contracts";
import type {
  OperatorFeedbackPage,
  OperatorFeedbackQuery,
} from "@moya/contracts/internal/community-operator";

import type { PublishingMediaReadTarget } from "./work-publishing-port.js";

/** Feedback is private: public callers can submit, only the operator can list. */
export interface FeedbackPort {
  submitFeedback(
    actor: string,
    input: SubmitFeedbackRequest,
  ): Promise<FeedbackReceipt>;
  resolveFeedbackImage(
    feedbackId: string,
    itemId: string,
    variant: FeedbackImageVariant,
  ): Promise<PublishingMediaReadTarget | null>;
  operatorListFeedback(
    query: OperatorFeedbackQuery,
  ): Promise<OperatorFeedbackPage>;
}
