import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../../community/application/errors/community-request-errors.js";
import { articleAuthoringArticleIdSchema } from "@moya/contracts/schemas";
import {
  articlePendingListQuerySchema,
  articlePendingMediaQuerySchema,
  moderateArticlePendingCommandSchema,
} from "@moya/contracts/internal/community-operator";

export const parseArticlePendingId = (value: unknown) => {
  const result = articleAuthoringArticleIdSchema.safeParse(value);
  if (!result.success) throw new CommunityNotFoundError();
  return result.data;
};
export const parseArticlePendingListQuery = (value: unknown) => {
  const result = articlePendingListQuerySchema.safeParse(value);
  if (!result.success) throw new CommunityInputError("Invalid operator query");
  return result.data;
};
export const parseArticlePendingModerationCommand = (value: unknown) => {
  const result = moderateArticlePendingCommandSchema.safeParse(value);
  if (!result.success)
    throw new CommunityInputError("Invalid operator command");
  return result.data;
};

export const parseArticlePendingMediaQuery = (value: unknown) => {
  const result = articlePendingMediaQuerySchema.safeParse(value);
  if (!result.success) throw new CommunityInputError("Invalid operator query");
  return result.data;
};
