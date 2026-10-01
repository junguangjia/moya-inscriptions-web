import {
  articleOwnMediaListQuerySchema,
  articleAuthoringArticleIdSchema,
  articleAuthoringCreateSchema,
  articleAuthoringUpdateSchema,
  deleteArticleDraftCommandSchema,
  articleAuthoringCandidateSchema,
  articleAuthoringListQuerySchema,
  articleBlockEditsCommandSchema,
} from "@moya/contracts/schemas";
import { CommunityInputError } from "../../community/application/errors/community-request-errors.js";

/** Human HTTP and delegated MCP use these same strict transport parsers. */
const parse = <Value>(
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: Value }
      | { success: false; error: { issues: readonly { message: string }[] } };
  },
  input: unknown,
  code: string,
): Value => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const unsupported = result.error.issues.some(
    (issue) => issue.message === "article_unsupported_document_version",
  );
  throw new CommunityInputError(
    unsupported ? "article_unsupported_document_version" : code,
  );
};

export const parseArticleId = (input: unknown) =>
  parse(articleAuthoringArticleIdSchema, input, "article_invalid_id");
export const parseArticleDraftCreateCommand = (input: unknown) =>
  parse(articleAuthoringCreateSchema, input, "article_invalid_command");
export const parseArticleDraftUpdateCommand = (input: unknown) =>
  parse(articleAuthoringUpdateSchema, input, "article_invalid_command");
export const parseArticleDraftDeletionCommand = (input: unknown) =>
  parse(
    deleteArticleDraftCommandSchema,
    input,
    "article_invalid_delete_command",
  );
export const parseArticleCandidateCommand = (input: unknown) =>
  parse(articleAuthoringCandidateSchema, input, "article_invalid_candidate");
export const parseArticleDraftListQuery = (input: unknown) =>
  parse(articleAuthoringListQuerySchema, input, "article_invalid_query");
export const parseArticleBlockEditsCommand = (input: unknown) =>
  parse(articleBlockEditsCommandSchema, input, "article_invalid_block_edits");

export const parseArticleOwnMediaListQuery = (input: unknown) =>
  parse(articleOwnMediaListQuerySchema, input, "article_invalid_media_query");
