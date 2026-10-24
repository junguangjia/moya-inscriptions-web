import { parseFeedbackSubmission } from "../mappers/feedback-contract-mapper.js";
import {
  operatorFeedbackQuerySchema,
  operatorFeedbackMediaRequestSchema,
} from "@moya/contracts/internal/community-operator";
import { CommunityInputError } from "../errors/community-request-errors.js";
import { openPublishingMedia } from "./work-publishing-service.js";
import type {
  PublishingMediaByteRange,
  PublishingMediaStorePort,
} from "../ports/publishing-media-store-port.js";
import type { FeedbackPort } from "../ports/feedback-port.js";

export class FeedbackService {
  constructor(
    private readonly port: FeedbackPort,
    private readonly store?: PublishingMediaStorePort,
  ) {}

  submit(actor: string, input: unknown) {
    return this.port.submitFeedback(actor, parseFeedbackSubmission(input));
  }

  openOperatorImage(
    feedbackId: string,
    itemId: string,
    variant: string,
    range?: PublishingMediaByteRange,
  ) {
    const parsed = operatorFeedbackMediaRequestSchema.safeParse({
      feedbackId,
      itemId,
      variant,
    });
    if (!parsed.success)
      throw new CommunityInputError("Invalid feedback image request");
    return openPublishingMedia(
      this.store,
      () =>
        this.port.resolveFeedbackImage(
          parsed.data.feedbackId,
          parsed.data.itemId,
          parsed.data.variant,
        ),
      range,
    );
  }

  operatorList(query: unknown) {
    const parsed = operatorFeedbackQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new CommunityInputError("Invalid feedback query");
    return this.port.operatorListFeedback(parsed.data);
  }
}
