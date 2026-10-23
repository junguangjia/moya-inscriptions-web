import { parseFeedbackSubmission } from "../mappers/feedback-contract-mapper.js";
import { operatorFeedbackQuerySchema } from "@moya/contracts/internal/community-operator";
import { CommunityInputError } from "../errors/community-request-errors.js";
import type { FeedbackPort } from "../ports/feedback-port.js";

export class FeedbackService {
  constructor(private readonly port: FeedbackPort) {}

  submit(actor: string, input: unknown) {
    return this.port.submitFeedback(actor, parseFeedbackSubmission(input));
  }

  operatorList(query: unknown) {
    const parsed = operatorFeedbackQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new CommunityInputError("Invalid feedback query");
    return this.port.operatorListFeedback(parsed.data);
  }
}
