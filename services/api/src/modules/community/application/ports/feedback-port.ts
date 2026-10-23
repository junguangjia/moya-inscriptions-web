import type { FeedbackReceipt, SubmitFeedbackRequest } from "@moya/contracts";
import type {
  OperatorFeedbackPage,
  OperatorFeedbackQuery,
} from "@moya/contracts/internal/community-operator";

/** Feedback is private: public callers can submit, only the operator can list. */
export interface FeedbackPort {
  submitFeedback(
    actor: string,
    input: SubmitFeedbackRequest,
  ): Promise<FeedbackReceipt>;
  operatorListFeedback(
    query: OperatorFeedbackQuery,
  ): Promise<OperatorFeedbackPage>;
}
