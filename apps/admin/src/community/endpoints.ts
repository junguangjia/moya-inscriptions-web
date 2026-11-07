import {
  adminReadArticleSubmissionRequestSchema,
  adminModerateArticleSubmissionRequestSchema,
  articlePendingCandidateSchema,
  articlePendingListQuerySchema,
  articlePendingMediaQuerySchema,
  articlePendingPageSchema,
  articlePendingPreviewSchema,
  articleModerationResultSchema,
  adminBulkModerateCommentsRequestSchema,
  operatorContentQuerySchema,
  operatorWorksQuerySchema,
  operatorFeaturedQuerySchema,
  operatorUsersQuerySchema,
  operatorUserPageSchema,
  operatorFeedbackQuerySchema,
  operatorFeedbackPageSchema,
  operatorFeedbackMediaRequestSchema,
  operatorCommentMediaRequestSchema,
  recommendUserCommandSchema,
  adminModerateWorkRequestSchema,
  featuredMutationSchema,
  featuredSettingsMutationSchema,
  adminDeleteBodySchema,
  adminRemoveThreadSchema,
  adminModerateCommentRequestSchema,
  adminModerateUserRequestSchema,
  adminReadCommentRequestSchema,
  moderationEventQuerySchema,
  moderationSummaryQuerySchema,
  operatorCommentQuerySchema,
  publicationPolicyStateSchema,
  setPublicationPolicyCommandSchema,
  adminModerateWorkSubmissionRequestSchema,
  adminPublishingJobRequestSchema,
  adminReadAccountCapacityRequestSchema,
  adminReadWorkSubmissionRequestSchema,
  adminSetAccountCapacityClassRequestSchema,
  operatorAccountCapacitySchema,
  operatorPublishingJobPageSchema,
  operatorPublishingJobSchema,
  operatorPublishingJobQuerySchema,
  operatorSubmissionMediaSchema,
  operatorWorkSubmissionPageSchema,
  operatorWorkSubmissionQuerySchema,
  operatorWorkSubmissionSchema,
  setWorkPublishingSettingsCommandSchema,
  workPublishingSettingsSchema,
  workSubmissionModerationResultSchema,
  adminUpdateThreadRequestSchema,
  createThreadCommandSchema,
  operatorThreadPageSchema,
  operatorThreadSchema,
  operatorThreadsQuerySchema,
  adminRemoveDmMessageRequestSchema,
  operatorDmConversationSchema,
  operatorDmLookupRequestSchema,
  operatorDmMessageSchema,
  operatorDmReadRequestSchema,
  operatorReportQuerySchema,
  operatorReportSchema,
  operatorReportPageSchema,
  operatorReportAiAnswerSchema,
  operatorReportAiPageSchema,
  operatorUserAiPageSchema,
  operatorWorkPageSchema,
  featuredPageSchema,
  operatorCommentPageSchema,
  operatorCommentDetailSchema,
  moderationEventPageSchema,
  moderationSummarySchema,
  operatorReportDecisionRequestSchema,
  operatorReportReviewRequestSchema,
  operatorReportMetadataRequestSchema,
  operatorReportForwardRequestSchema,
  adminUpdateTimelineEntryRequestSchema,
  createTimelineEntryCommandSchema,
  operatorTimelineEntrySchema,
  operatorTimelinePageSchema,
  operatorTimelineQuerySchema,
  operatorTimelineSummarySchema,
  reorderTimelineCommandSchema,
  timelineReorderResultSchema,
  adminSetTimelinePostRequestSchema,
  operatorTimelinePostPageSchema,
  operatorTimelinePostQuerySchema,
  operatorTimelinePostSchema,
} from "@moya/contracts/internal/community-operator";
import { z } from "zod";
import {
  COMMENT_IMAGE_CAPABILITY_HEADER,
  commentImagePayloadFor,
} from "@moya/contracts/comment-images-protocol";

import { isOwner } from "../editorial/access";
import {
  agentAdminOperationNames,
  agentAdminOperations,
} from "./agent-operations";
import {
  callCommunityOperator,
  CommunityOperatorError,
  openCommunityOperatorMedia,
  openCommunityOperatorEvidence,
} from "./backend";

export {
  CommunityOperatorError,
  OPERATOR_EVIDENCE_TYPES,
  OPERATOR_EVIDENCE_MAXIMUM_BYTES,
  openCommunityOperatorEvidence,
  OPERATOR_MEDIA_LIFETIME_MS,
  OPERATOR_MEDIA_MAXIMUM_BYTES,
  OPERATOR_MEDIA_TYPES,
  OPERATOR_MEDIA_WAIT_MS,
  openCommunityOperatorMedia,
} from "./backend";
export type { OperatorMediaCall, OperatorMediaResponse } from "./backend";
export {
  WORK_PUBLISHING_LIMIT_FIELDS,
  limitDisplayValue,
  readLimitInput,
} from "./work-publishing-limits";
export {
  capacityDesignationAllowed,
  coverPreview,
  itemPreviewVariant,
  publishingJobActions,
  submissionDecidable,
  submissionUndecidableReason,
  submissionVariantKey,
} from "./work-publishing-rules";
export {
  AUTHORSHIP_NOT_SET,
  OperatorFailure,
  authorshipLabel,
  outcomeUnknown,
} from "./api";

import type { OperatorMediaCall } from "./backend";
import type { AdminOpOutput } from "@moya/contracts/internal/admin-mcp";
import type { Endpoint, PayloadRequest } from "payload";

/**
 * The Owner's Admin is a client of the Backend operator boundary and nothing
 * more. Every request envelope is validated strictly and completely here; the
 * subject id is mapped into the Backend route and only the validated command
 * body is forwarded. An unknown, extra or malformed field is refused before
 * any call is made. The acting identity is the server-side operator label the
 * Backend holds; no request field can name an actor.
 */
export type OperatorCall = <Result>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
) => Promise<Result>;

/**
 * These routes are the Owner's interface, and `automation` never moderates. AI runs
 * the same definitions through apps/admin/src/admin-mcp, on its own credential.
 */
const requireOwner = (req: PayloadRequest): void => {
  if (!isOwner(req))
    throw new CommunityOperatorError("COMMUNITY_OWNER_ONLY", 403);
};

const readJson = async (req: PayloadRequest): Promise<unknown> => {
  if (!req.json) throw new CommunityOperatorError("JSON_BODY_REQUIRED", 400);
  try {
    return await req.json();
  } catch {
    throw new CommunityOperatorError("JSON_BODY_REQUIRED", 400);
  }
};

const parse = <Schema extends { parse: (input: unknown) => unknown }>(
  schema: Schema,
  input: unknown,
): ReturnType<Schema["parse"]> => {
  try {
    return schema.parse(input) as ReturnType<Schema["parse"]>;
  } catch {
    throw new CommunityOperatorError("COMMAND_INVALID", 400);
  }
};

/**
 * The whole validated query, each field URL-encoded once. No field is named here, so a
 * filter the schema takes always reaches the Backend, which refuses one it does not.
 */
const toQuery = (
  values: Readonly<Record<string, string | number | undefined>>,
): string => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(values))
    if (value !== undefined) search.set(name, String(value));
  return search.size === 0 ? "" : `?${search.toString()}`;
};

const segment = (id: string): string => encodeURIComponent(id);

/** A read that takes no parameters still refuses any field. */
const noParameters = z.strictObject({});

/**
 * Work publishing answers are parsed against the shared operator contracts
 * before they reach the view, so a media descriptor, id or count the Admin
 * relies on is exactly what the contract allows. A mismatch is a content-free
 * failure: the answer itself is never logged or echoed.
 */
const checked = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.infer<Schema> => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new CommunityOperatorError("OPERATOR_RESPONSE_INVALID", 502);
  return result.data;
};

/** The Admin envelope for a job action; the id and the action travel in the route. */
const adminPublishingJobActionRequestSchema =
  adminPublishingJobRequestSchema.omit({ action: true });

/** Route parameters of one derivative of one item of one explicit submission. */
const workSubmissionMediaRequestSchema = operatorSubmissionMediaSchema
  .pick({ itemId: true, editKey: true })
  .extend({
    revisionId: adminReadWorkSubmissionRequestSchema.shape.id,
    variant: operatorSubmissionMediaSchema.shape.variants.element,
  });

export type CommunityOperation = (
  req: PayloadRequest,
  input: unknown,
) => Promise<unknown>;

// Half a surrogate pair names no record, and `segment` could not encode it. This also
// checks evidence ids, so it says nothing of a report's own shape.
const reportIdSchema = operatorReportSchema.shape.id
  .min(1)
  .max(128)
  .regex(/^\S+$/u)
  .refine((id) => !/\p{Cs}/u.test(id));
const readReportRequestSchema = z.strictObject({ id: reportIdSchema });
const reportEvidenceRequestSchema = readReportRequestSchema.extend({
  evidenceId: reportIdSchema,
});

/**
 * One operation, whichever transport carries it. `output` holds the checked answer
 * by actor; the Owner route checks only what it has always checked. `body` names
 * the two ways this route has always read its body more loosely than `input`.
 */
export interface CommunityOperationDefinition {
  readonly input: z.ZodType;
  readonly output: AdminOpOutput;
  /** `optional`: no body reads as `{}`. `ignored`: the Owner route reads none. */
  readonly body?: "optional" | "ignored";
  readonly run: (
    parsed: unknown,
    call: OperatorCall,
    req: PayloadRequest,
  ) => Promise<unknown>;
}

const define = <Input extends z.ZodType>({
  run,
  ...definition
}: Pick<CommunityOperationDefinition, "body"> & {
  readonly input: Input;
  readonly output?: AdminOpOutput;
  readonly run: (
    parsed: z.output<Input>,
    call: OperatorCall,
    req: PayloadRequest,
  ) => Promise<unknown>;
}): CommunityOperationDefinition => ({
  output: {},
  ...definition,
  run: (parsed, call, req) => run(parsed as z.output<Input>, call, req),
});

const decideReportRequestSchema = operatorReportDecisionRequestSchema.extend({
  id: reportIdSchema,
});
const reviewReportRequestSchema = operatorReportReviewRequestSchema.extend({
  id: reportIdSchema,
});
const reportMetadataRequestSchema = operatorReportMetadataRequestSchema.extend({
  id: reportIdSchema,
});
const forwardReportRequestSchema = operatorReportForwardRequestSchema.extend({
  id: reportIdSchema,
});

export const communityOperationDefinitions = {
  "read-reports": define({
    input: operatorReportQuerySchema,
    output: { owner: operatorReportPageSchema, ai: operatorReportAiPageSchema },
    run: (query, call) => call("GET", `reports${toQuery(query)}`),
  }),
  "read-report": define({
    input: readReportRequestSchema,
    output: { owner: operatorReportSchema, ai: operatorReportAiAnswerSchema },
    run: ({ id }, call) => call("GET", `reports/${segment(id)}`),
  }),
  "decide-report": define({
    input: decideReportRequestSchema,
    output: { owner: operatorReportSchema, ai: operatorReportAiAnswerSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `reports/${segment(id)}/decisions`, command),
  }),
  "review-report": define({
    input: reviewReportRequestSchema,
    output: { owner: operatorReportSchema, ai: operatorReportAiAnswerSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `reports/${segment(id)}/review`, command),
  }),
  "set-report-metadata": define({
    input: reportMetadataRequestSchema,
    output: { owner: operatorReportSchema, ai: operatorReportAiAnswerSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `reports/${segment(id)}/metadata`, command),
  }),
  "forward-report": define({
    input: forwardReportRequestSchema,
    output: { owner: operatorReportSchema, ai: operatorReportAiAnswerSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `reports/${segment(id)}/forward`, command),
  }),
  "read-feedback": define({
    input: operatorFeedbackQuerySchema,
    output: { owner: operatorFeedbackPageSchema },
    run: (query, call) => call("GET", `feedback${toQuery(query)}`),
  }),
  "read-works": define({
    input: operatorWorksQuerySchema,
    output: { ai: operatorWorkPageSchema },
    run: (query, call) => call("GET", `works${toQuery(query)}`),
  }),
  "read-users": define({
    input: operatorUsersQuerySchema,
    output: { owner: operatorUserPageSchema, ai: operatorUserAiPageSchema },
    run: (query, call) => call("GET", `users${toQuery(query)}`),
  }),
  "recommend-user": define({
    input: recommendUserCommandSchema,
    run: (command, call) => call("PUT", "users/recommendation", command),
  }),
  "moderate-work": define({
    input: adminModerateWorkRequestSchema,
    run: ({ id, ...command }, call) =>
      call("POST", `works/${segment(id)}/moderation`, command),
  }),
  "read-featured": define({
    input: operatorFeaturedQuerySchema,
    output: { ai: featuredPageSchema },
    run: (query, call) => call("GET", `featured${toQuery(query)}`),
  }),
  "set-featured": define({
    input: featuredMutationSchema,
    run: (command, call) => call("PUT", "featured", command),
  }),
  "set-featured-quantity": define({
    input: featuredSettingsMutationSchema,
    run: (command, call) => call("PUT", "featured/settings", command),
  }),
  "delete-body": define({
    input: adminDeleteBodySchema,
    run: ({ id, ...command }, call) =>
      call("POST", `comments/${segment(id)}/delete-body`, command),
  }),
  "remove-thread": define({
    input: adminRemoveThreadSchema,
    run: ({ id, ...command }, call) =>
      call("POST", `comments/${segment(id)}/remove-thread`, command),
  }),
  // content-community-completion-v1: narrow Owner-only DM moderation. One
  // explicitly selected conversation with a stated purpose; every access is
  // audited content-free on the Backend. No listing or search of messages.
  "read-dm-conversation": define({
    input: operatorDmReadRequestSchema,
    output: { owner: operatorDmConversationSchema },
    run: (command, call) => call("POST", "messages/conversation", command),
  }),
  "lookup-dm-conversation": define({
    input: operatorDmLookupRequestSchema,
    output: { owner: operatorDmConversationSchema },
    run: (command, call) => call("POST", "messages/lookup", command),
  }),
  "remove-dm-message": define({
    input: adminRemoveDmMessageRequestSchema,
    output: { owner: operatorDmMessageSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `messages/${segment(id)}/remove`, command),
  }),
  // content-community-completion-v1: operator-managed Threads.
  "read-threads": define({
    input: operatorThreadsQuerySchema,
    output: { owner: operatorThreadPageSchema },
    run: (query, call) =>
      call(
        "GET",
        `threads${toQuery({
          ...query,
          includeHidden: query.includeHidden ? "true" : "false",
        })}`,
      ),
  }),
  "create-thread": define({
    input: createThreadCommandSchema,
    output: { owner: operatorThreadSchema },
    run: (command, call) => call("POST", "threads", command),
  }),
  "update-thread": define({
    input: adminUpdateThreadRequestSchema,
    output: { owner: operatorThreadSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `threads/${segment(id)}`, command),
  }),
  "read-feature-catalogs": define({
    input: operatorContentQuerySchema,
    run: async (query, _call, req) => {
      const result = await req.payload.find({
        collection: "catalogs",
        req,
        overrideAccess: false,
        where: {
          and: [
            { _status: { equals: "published" } },
            ...(query.search ? [{ title: { contains: query.search } }] : []),
          ],
        },
        draft: false,
        depth: 0,
        page: query.page,
        limit: query.pageSize,
        sort: "title",
        select: { catalogId: true, title: true },
      });
      return {
        items: result.docs.map((doc) => ({
          id: doc.catalogId,
          title: doc.title,
        })),
        total: result.totalDocs,
        page: result.page,
        pageSize: result.limit,
      };
    },
  }),
  "read-policy": define({
    input: noParameters,
    output: { ai: publicationPolicyStateSchema },
    body: "ignored",
    run: (_query, call) => call("GET", "publication-policy"),
  }),
  "set-policy": define({
    input: setPublicationPolicyCommandSchema,
    run: (command, call) => call("PUT", "publication-policy", command),
  }),
  "read-comments": define({
    input: operatorCommentQuerySchema,
    output: { ai: operatorCommentPageSchema },
    body: "optional",
    run: (query, call) => call("GET", `comments${toQuery(query)}`),
  }),
  "read-comment": define({
    input: adminReadCommentRequestSchema,
    output: { ai: operatorCommentDetailSchema },
    run: ({ id }, call) => call("GET", `comments/${segment(id)}`),
  }),
  "moderate-comment": define({
    input: adminModerateCommentRequestSchema,
    run: ({ id, action, reason }, call) =>
      call("POST", `comments/${segment(id)}/moderation`, { action, reason }),
  }),
  "moderate-comments": define({
    input: adminBulkModerateCommentsRequestSchema,
    run: ({ ids, action, reason }, call) =>
      call("POST", "comments/moderation", { action, ids, reason }),
  }),
  "moderate-user": define({
    input: adminModerateUserRequestSchema,
    run: ({ id, action, reason }, call) =>
      call("POST", `users/${segment(id)}/status`, { action, reason }),
  }),
  "read-events": define({
    input: moderationEventQuerySchema,
    output: { ai: moderationEventPageSchema },
    body: "optional",
    run: (query, call) => call("GET", `moderation-events${toQuery(query)}`),
  }),
  "read-summary": define({
    input: moderationSummaryQuerySchema,
    output: { ai: moderationSummarySchema },
    body: "optional",
    run: (query, call) => call("GET", `summary${toQuery(query)}`),
  }),
  // Work publishing (Development): the independent work publication policy
  // and limits, explicit submissions, account capacity and job outcomes.
  "read-work-publishing-settings": define({
    input: noParameters,
    output: { owner: workPublishingSettingsSchema },
    run: (_query, call) => call("GET", "publishing/settings"),
  }),
  "set-work-publishing-settings": define({
    input: setWorkPublishingSettingsCommandSchema,
    output: { owner: workPublishingSettingsSchema },
    run: (command, call) => call("PUT", "publishing/settings", command),
  }),
  "read-article-submissions": define({
    input: articlePendingListQuerySchema,
    output: { owner: articlePendingPageSchema },
    run: (query, call) => call("GET", `articles/submissions${toQuery(query)}`),
  }),
  "read-article-submission": define({
    input: adminReadArticleSubmissionRequestSchema,
    output: {
      owner: articlePendingPreviewSchema,
      ai: articlePendingCandidateSchema,
    },
    run: ({ id }, call) => call("GET", `articles/${segment(id)}/submission`),
  }),
  "moderate-article-submission": define({
    input: adminModerateArticleSubmissionRequestSchema,
    output: { owner: articleModerationResultSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `articles/${segment(id)}/moderation`, command),
  }),
  "read-work-submissions": define({
    input: operatorWorkSubmissionQuerySchema,
    output: { owner: operatorWorkSubmissionPageSchema },
    run: (query, call) =>
      call("GET", `publishing/submissions${toQuery(query)}`),
  }),
  "read-work-submission": define({
    input: adminReadWorkSubmissionRequestSchema,
    output: { owner: operatorWorkSubmissionSchema },
    run: ({ id }, call) => call("GET", `publishing/submissions/${segment(id)}`),
  }),
  "moderate-work-submission": define({
    input: adminModerateWorkSubmissionRequestSchema,
    output: { owner: workSubmissionModerationResultSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `publishing/submissions/${segment(id)}/moderation`, command),
  }),
  "read-account-capacity": define({
    input: adminReadAccountCapacityRequestSchema,
    output: { owner: operatorAccountCapacitySchema },
    run: ({ accountId }, call) =>
      call("GET", `publishing/accounts/${segment(accountId)}/capacity`),
  }),
  "set-account-capacity": define({
    input: adminSetAccountCapacityClassRequestSchema,
    output: { owner: operatorAccountCapacitySchema },
    run: ({ accountId, ...command }, call) =>
      call(
        "PUT",
        `publishing/accounts/${segment(accountId)}/capacity`,
        command,
      ),
  }),
  "read-publishing-jobs": define({
    input: operatorPublishingJobQuerySchema,
    output: { owner: operatorPublishingJobPageSchema },
    run: (query, call) => call("GET", `publishing/jobs${toQuery(query)}`),
  }),
  "retry-publishing-job": define({
    input: adminPublishingJobActionRequestSchema,
    output: { owner: operatorPublishingJobSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `publishing/jobs/${segment(id)}/retry`, command),
  }),
  "abandon-publishing-job": define({
    input: adminPublishingJobActionRequestSchema,
    output: { owner: operatorPublishingJobSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `publishing/jobs/${segment(id)}/abandon`, command),
  }),
  // home-timeline-v1 (Issue #384 r3): the Home timeline's rows, which the
  // database holds. The Backend checks every write against the whole set.
  "read-timeline": define({
    input: operatorTimelineQuerySchema,
    output: { owner: operatorTimelinePageSchema },
    // `posts=any` is the default, and a Backend before timeline-posts-v1 knows
    // no such key, so it is sent only when it narrows.
    run: ({ ids, onAxis, disputed, posts, ...query }, call) =>
      call(
        "GET",
        `timeline-entries${toQuery({
          ...query,
          ids: ids?.join(","),
          onAxis: onAxis === undefined ? undefined : String(onAxis),
          disputed: disputed === undefined ? undefined : String(disputed),
          posts: posts === "any" ? undefined : posts,
        })}`,
      ),
  }),
  "read-timeline-summary": define({
    input: noParameters,
    output: { owner: operatorTimelineSummarySchema },
    run: (_query, call) => call("GET", "timeline-summary"),
  }),
  "create-timeline-entry": define({
    input: createTimelineEntryCommandSchema,
    output: { owner: operatorTimelineEntrySchema },
    run: (command, call) => call("POST", "timeline-entries", command),
  }),
  "update-timeline-entry": define({
    input: adminUpdateTimelineEntryRequestSchema,
    output: { owner: operatorTimelineEntrySchema },
    run: ({ id, ...command }, call) =>
      call("POST", `timeline-entries/${segment(id)}`, command),
  }),
  "reorder-timeline": define({
    input: reorderTimelineCommandSchema,
    output: { owner: timelineReorderResultSchema },
    run: (command, call) => call("POST", "timeline-order", command),
  }),
  // timeline-posts-v1: users' posts on the Home timeline's rows. AI never
  // reads a self-only work here, and a write on one answers its refusal.
  "read-timeline-posts": define({
    input: operatorTimelinePostQuerySchema,
    output: { owner: operatorTimelinePostPageSchema },
    run: (query, call) => call("GET", `timeline-posts${toQuery(query)}`),
  }),
  "set-timeline-post": define({
    input: adminSetTimelinePostRequestSchema,
    output: { owner: operatorTimelinePostSchema },
    run: ({ id, ...command }, call) =>
      call("POST", `timeline-posts/${segment(id)}`, command),
  }),
};

export type CommunityOperationName = keyof typeof communityOperationDefinitions;

export const communityOperations = (
  call: OperatorCall,
): Readonly<Record<string, CommunityOperation>> =>
  Object.fromEntries(
    Object.entries(communityOperationDefinitions).map(
      ([name, definition]): [string, CommunityOperation] => [
        name,
        async (req, input) => {
          const parsed =
            definition.body === "ignored"
              ? undefined
              : parse(
                  definition.input,
                  definition.body === "optional" ? (input ?? {}) : input,
                );
          const answer = await definition.run(parsed, call, req);
          return definition.output.owner === undefined
            ? answer
            : checked(definition.output.owner, answer);
        },
      ],
    ),
  );

// Machine administration remains a separate Development-only boundary.
const developmentOnlyOperations: ReadonlySet<string> = new Set(
  agentAdminOperationNames,
);

/** A single well-formed byte range is relayed; anything else reads the whole derivative. */
const byteRange = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const match = /^bytes=(\d{0,15})-(\d{0,15})$/u.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;
  if (match[1] !== "" && match[2] !== "" && Number(match[1]) > Number(match[2]))
    return null;
  return `bytes=${match[1]}-${match[2]}`;
};

const failure = (error: unknown, req: PayloadRequest): Response => {
  if (!(error instanceof CommunityOperatorError))
    req.payload.logger.error({ err: error });
  return Response.json(
    {
      ok: false as const,
      error: {
        code:
          error instanceof CommunityOperatorError
            ? error.code
            : "OPERATION_FAILED",
      },
    },
    {
      status: error instanceof CommunityOperatorError ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
};

const endpoint = (name: string, operation: CommunityOperation): Endpoint => ({
  path: `/community-moderation/${name}`,
  method: "post",
  handler: async (req) => {
    try {
      requireOwner(req);
      if (
        developmentOnlyOperations.has(name) &&
        process.env.NODE_ENV !== "development"
      )
        throw new CommunityOperatorError("NOT_FOUND", 404);
      const input = await readJson(req);
      const result = await operation(req, input);
      const commentJson = name === "read-comments" || name === "read-comment";
      return Response.json(
        {
          ok: true,
          result: commentJson
            ? commentImagePayloadFor(
                req.headers?.get(COMMENT_IMAGE_CAPABILITY_HEADER),
                result,
              )
            : result,
        },
        {
          headers: {
            "Cache-Control": "no-store",
            ...(commentJson
              ? { Vary: `Cookie, ${COMMENT_IMAGE_CAPABILITY_HEADER}` }
              : {}),
          },
        },
      );
    } catch (error) {
      return failure(error, req);
    }
  },
});

/**
 * The Owner-only binary relay for submission previews:
 * `<img>`/`<video>` sources on the same origin, streamed from the Backend
 * operator media route. Only derivatives exist there; the relay repeats the
 * content-type allow-list, never lets a response be cached, sniffed, framed
 * into a document or embedded elsewhere.
 */
const workSubmissionMediaEndpoint = (
  openMedia: OperatorMediaCall,
): Endpoint => ({
  path: "/community-moderation/work-submission-media/:revisionId/:itemId/:variant/:editKey",
  method: "get",
  handler: async (req) => {
    try {
      requireOwner(req);
      const params = req.routeParams ?? {};
      const { revisionId, itemId, variant, editKey } = parse(
        workSubmissionMediaRequestSchema,
        {
          revisionId: params.revisionId,
          itemId: params.itemId,
          variant: params.variant,
          editKey: params.editKey,
        },
      );
      const media = await openMedia(
        `publishing/media/${segment(revisionId)}/${segment(itemId)}/${variant}/${editKey}`,
        byteRange(req.headers?.get("range")),
        req.signal,
      );
      const headers = new Headers({
        "Content-Type": media.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie, Range",
      });
      if (media.acceptsRanges) headers.set("Accept-Ranges", "bytes");
      if (media.contentLength !== null)
        headers.set("Content-Length", media.contentLength);
      if (media.contentRange !== null)
        headers.set("Content-Range", media.contentRange);
      return new Response(media.body, { status: media.status, headers });
    } catch (error) {
      return failure(error, req);
    }
  },
});

/** A private pending-candidate derivative, never an arbitrary author-media proxy. */
const articleSubmissionMediaEndpoint = (
  openMedia: OperatorMediaCall,
): Endpoint => ({
  path: "/community-moderation/article-submission-media/:id",
  method: "get",
  handler: async (req) => {
    try {
      requireOwner(req);
      const { id } = parse(adminReadArticleSubmissionRequestSchema, {
        id: req.routeParams?.id,
      });
      const values: Record<string, string> = {};
      const url = new URL(req.url ?? "http://request.invalid");
      for (const [name, value] of url.searchParams) {
        if (Object.hasOwn(values, name))
          throw new CommunityOperatorError("COMMAND_INVALID", 400);
        Object.defineProperty(values, name, { value, enumerable: true });
      }
      const query = parse(articlePendingMediaQuerySchema, values);
      const media = await openMedia(
        `articles/${segment(id)}/submission-media${toQuery(query)}`,
        byteRange(req.headers?.get("range")),
        req.signal,
      );
      const headers = new Headers({
        "Content-Type": media.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie, Range",
      });
      if (media.acceptsRanges) headers.set("Accept-Ranges", "bytes");
      if (media.contentLength !== null)
        headers.set("Content-Length", media.contentLength);
      if (media.contentRange !== null)
        headers.set("Content-Range", media.contentRange);
      return new Response(media.body, { status: media.status, headers });
    } catch (error) {
      return failure(error, req);
    }
  },
});

/** Evidence bytes stay behind Owner authentication on both HTTP hops. */
const reportEvidenceEndpoint = (openEvidence: OperatorMediaCall): Endpoint => ({
  path: "/community-moderation/report-evidence/:id/:evidenceId",
  method: "get",
  handler: async (req) => {
    try {
      requireOwner(req);
      const { id, evidenceId } = parse(reportEvidenceRequestSchema, {
        id: req.routeParams?.id,
        evidenceId: req.routeParams?.evidenceId,
      });
      const media = await openEvidence(
        `reports/${segment(id)}/evidence/${segment(evidenceId)}`,
        null,
        req.signal,
      );
      return new Response(media.body, {
        status: media.status,
        headers: {
          "Content-Type": media.contentType,
          "Content-Disposition": 'attachment; filename="report-evidence"',
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          Vary: "Cookie",
          ...(media.contentLength === null
            ? {}
            : { "Content-Length": media.contentLength }),
        },
      });
    } catch (error) {
      return failure(error, req);
    }
  },
});

/** Private feedback screenshots: association-authorized rendered WebP only. */
const feedbackMediaEndpoint = (openMedia: OperatorMediaCall): Endpoint => ({
  path: "/community-moderation/feedback-media/:feedbackId/:itemId/:variant",
  method: "get",
  handler: async (req) => {
    try {
      requireOwner(req);
      const params = req.routeParams ?? {};
      const { feedbackId, itemId, variant } = parse(
        operatorFeedbackMediaRequestSchema,
        {
          feedbackId: params.feedbackId,
          itemId: params.itemId,
          variant: params.variant,
        },
      );
      if (new URL(req.url ?? "http://request.invalid").search !== "")
        throw new CommunityOperatorError("COMMAND_INVALID", 400);
      const media = await openMedia(
        `feedback/${segment(feedbackId)}/images/${segment(itemId)}/${variant}`,
        byteRange(req.headers?.get("range")),
        req.signal,
      );
      if (media.contentType !== "image/webp") {
        await media.body.cancel().catch(() => undefined);
        throw new CommunityOperatorError("OPERATION_FAILED", 502);
      }
      const headers = new Headers({
        "Content-Type": media.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie, Range",
      });
      if (media.acceptsRanges) headers.set("Accept-Ranges", "bytes");
      if (media.contentLength !== null)
        headers.set("Content-Length", media.contentLength);
      if (media.contentRange !== null)
        headers.set("Content-Range", media.contentRange);
      return new Response(media.body, { status: media.status, headers });
    } catch (error) {
      return failure(error, req);
    }
  },
});

/** Comment pictures retain their current discussion association, including review. */
const commentMediaEndpoint = (openMedia: OperatorMediaCall): Endpoint => ({
  path: "/community-moderation/comment-media/:commentId/:itemId/:variant",
  method: "get",
  handler: async (req) => {
    try {
      requireOwner(req);
      const params = req.routeParams ?? {};
      const { commentId, itemId, variant } = parse(
        operatorCommentMediaRequestSchema,
        {
          commentId: params.commentId,
          itemId: params.itemId,
          variant: params.variant,
        },
      );
      if (!/^comment-[0-9a-f]{32}$/u.test(commentId))
        throw new CommunityOperatorError("COMMAND_INVALID", 400);
      if (new URL(req.url ?? "http://request.invalid").search !== "")
        throw new CommunityOperatorError("COMMAND_INVALID", 400);
      const requestedRange = req.headers?.get("range");
      const range = byteRange(requestedRange);
      if (requestedRange != null && range === null)
        throw new CommunityOperatorError("RANGE_NOT_SATISFIABLE", 416);
      const media = await openMedia(
        `comments/${segment(commentId)}/images/${segment(itemId)}/${variant}`,
        range,
        req.signal,
      );
      if (
        !["image/webp", "image/jpeg", "image/png"].includes(media.contentType)
      ) {
        await media.body.cancel().catch(() => undefined);
        throw new CommunityOperatorError("OPERATION_FAILED", 502);
      }
      const headers = new Headers({
        "Content-Type": media.contentType,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        Vary: "Cookie, Range",
      });
      if (media.acceptsRanges) headers.set("Accept-Ranges", "bytes");
      if (media.contentLength !== null)
        headers.set("Content-Length", media.contentLength);
      if (media.contentRange !== null)
        headers.set("Content-Range", media.contentRange);
      return new Response(media.body, { status: media.status, headers });
    } catch (error) {
      return failure(error, req);
    }
  },
});

/** The real endpoint set, with the transports injectable for boundary tests. */
export const createCommunityEndpoints = (
  call: OperatorCall = callCommunityOperator,
  openMedia: OperatorMediaCall = openCommunityOperatorMedia,
  openEvidence: OperatorMediaCall = openCommunityOperatorEvidence,
): Endpoint[] => [
  ...Object.entries({
    ...communityOperations(call),
    ...agentAdminOperations(call),
  }).map(([name, operation]) => endpoint(name, operation)),
  workSubmissionMediaEndpoint(openMedia),
  articleSubmissionMediaEndpoint(openMedia),
  reportEvidenceEndpoint(openEvidence),
  feedbackMediaEndpoint(openMedia),
  commentMediaEndpoint(openMedia),
];

export const communityEndpoints: Endpoint[] = createCommunityEndpoints();
