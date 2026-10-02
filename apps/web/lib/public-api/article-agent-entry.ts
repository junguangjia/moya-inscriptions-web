import {
  articleApprovalCandidateSchema,
  createArticleAuthoringGrantCommandSchema,
} from "@moya/contracts/schemas";
/** Parse ordinary human-entry identifiers at the existing public API boundary. */
export const parseArticleApprovalEntry = (
  query: Record<string, string | string[] | undefined>,
) => {
  const version =
    typeof query.version === "string" &&
    /^[1-9][0-9]{0,15}$/u.test(query.version)
      ? Number(query.version)
      : null;
  const result = articleApprovalCandidateSchema.safeParse({
    connectionId: query.connection,
    articleId: query.article,
    expectedVersion: version,
    fingerprint: query.fingerprint,
  });
  return result.success ? result.data : null;
};
export const parseArticleConsentEntry = (value: string) => {
  const result =
    createArticleAuthoringGrantCommandSchema.shape.interactionUid.safeParse(
      value,
    );
  return result.success ? result.data : null;
};
