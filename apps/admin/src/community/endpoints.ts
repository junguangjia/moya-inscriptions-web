import {
  adminBulkModerateCommentsRequestSchema,
  operatorContentQuerySchema,
  operatorWorksQuerySchema,
  operatorFeaturedQuerySchema,
  operatorUsersQuerySchema,
  operatorUserPageSchema,
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
} from "@moya/contracts/internal/community-operator";
import { z } from "zod";

import { isOwner } from "../editorial/access";
import {
  agentAdminOperationNames,
  agentAdminOperations,
} from "./agent-operations";
import {
  callCommunityOperator,
  CommunityOperatorError,
  openCommunityOperatorMedia,
} from "./backend";

export {
  CommunityOperatorError,
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
import type {
  BulkModerationResult,
  ModerationEventPage,
  ModerationResult,
  ModerationSummary,
  OperatorAccountCapacity,
  OperatorCommentDetail,
  OperatorCommentPage,
  OperatorPublishingJob,
  OperatorPublishingJobPage,
  OperatorWorkSubmission,
  OperatorWorkSubmissionPage,
  PublicationPolicyState,
  UserModerationResult,
  WorkPublishingSettings,
  WorkSubmissionModerationResult,
} from "@moya/contracts/internal/community-operator";
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

/** Community moderation is Owner-only; `automation` never moderates. */
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

/** Validated query fields only, in a fixed order, each URL-encoded once. */
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

export const communityOperations = (
  call: OperatorCall,
): Readonly<Record<string, CommunityOperation>> => ({
  "read-works": async (_req, input) =>
    call("GET", `works${toQuery(parse(operatorWorksQuerySchema, input))}`),
  "read-users": async (_req, input) =>
    checked(
      operatorUserPageSchema,
      await call(
        "GET",
        `users${toQuery(parse(operatorUsersQuerySchema, input))}`,
      ),
    ),
  "recommend-user": async (_req, input) =>
    call(
      "PUT",
      "users/recommendation",
      parse(recommendUserCommandSchema, input),
    ),
  "moderate-work": async (_req, input) => {
    const { id, ...command } = parse(adminModerateWorkRequestSchema, input);
    return call("POST", `works/${segment(id)}/moderation`, command);
  },
  "read-featured": async (_req, input) =>
    call(
      "GET",
      `featured${toQuery(parse(operatorFeaturedQuerySchema, input))}`,
    ),
  "set-featured": async (_req, input) =>
    call("PUT", "featured", parse(featuredMutationSchema, input)),
  "set-featured-quantity": async (_req, input) =>
    call(
      "PUT",
      "featured/settings",
      parse(featuredSettingsMutationSchema, input),
    ),
  "delete-body": async (_req, input) => {
    const { id, ...command } = parse(adminDeleteBodySchema, input);
    return call("POST", `comments/${segment(id)}/delete-body`, command);
  },
  "remove-thread": async (_req, input) => {
    const { id, ...command } = parse(adminRemoveThreadSchema, input);
    return call("POST", `comments/${segment(id)}/remove-thread`, command);
  },
  // content-community-completion-v1: narrow Owner-only DM moderation. One
  // explicitly selected conversation with a stated purpose; every access is
  // audited content-free on the Backend. No listing or search of messages.
  "read-dm-conversation": async (_req, input) =>
    checked(
      operatorDmConversationSchema,
      await call(
        "POST",
        "messages/conversation",
        parse(operatorDmReadRequestSchema, input),
      ),
    ),
  "lookup-dm-conversation": async (_req, input) =>
    checked(
      operatorDmConversationSchema,
      await call(
        "POST",
        "messages/lookup",
        parse(operatorDmLookupRequestSchema, input),
      ),
    ),
  "remove-dm-message": async (_req, input) => {
    const { id, ...command } = parse(adminRemoveDmMessageRequestSchema, input);
    return checked(
      operatorDmMessageSchema,
      await call("POST", `messages/${segment(id)}/remove`, command),
    );
  },
  // content-community-completion-v1: operator-managed Threads (Development).
  "read-threads": async (_req, input) =>
    checked(
      operatorThreadPageSchema,
      await call(
        "GET",
        `threads${toQuery({
          ...parse(operatorThreadsQuerySchema, input),
          includeHidden: parse(operatorThreadsQuerySchema, input).includeHidden
            ? "true"
            : "false",
        })}`,
      ),
    ),
  "create-thread": async (_req, input) =>
    checked(
      operatorThreadSchema,
      await call("POST", "threads", parse(createThreadCommandSchema, input)),
    ),
  "update-thread": async (_req, input) => {
    const { id, ...command } = parse(adminUpdateThreadRequestSchema, input);
    return checked(
      operatorThreadSchema,
      await call("POST", `threads/${segment(id)}`, command),
    );
  },
  "read-feature-catalogs": async (req, input) => {
    const query = parse(operatorContentQuerySchema, input);
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
  "read-policy": async (): Promise<PublicationPolicyState> =>
    call("GET", "publication-policy"),
  "set-policy": async (_req, input): Promise<PublicationPolicyState> =>
    call(
      "PUT",
      "publication-policy",
      parse(setPublicationPolicyCommandSchema, input),
    ),
  "read-comments": async (_req, input): Promise<OperatorCommentPage> => {
    const query = parse(operatorCommentQuerySchema, input ?? {});
    return call(
      "GET",
      `comments${toQuery({
        moderation: query.moderation,
        kind: query.kind,
        catalogId: query.catalogId,
        search: query.search,
        order: query.order,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  },
  "read-comment": async (_req, input): Promise<OperatorCommentDetail> => {
    const { id } = parse(adminReadCommentRequestSchema, input);
    return call("GET", `comments/${segment(id)}`);
  },
  "moderate-comment": async (_req, input): Promise<ModerationResult> => {
    const { id, action } = parse(adminModerateCommentRequestSchema, input);
    return call("POST", `comments/${segment(id)}/moderation`, { action });
  },
  "moderate-comments": async (_req, input): Promise<BulkModerationResult> => {
    const { ids, action } = parse(
      adminBulkModerateCommentsRequestSchema,
      input,
    );
    return call("POST", "comments/moderation", { action, ids });
  },
  "moderate-user": async (_req, input): Promise<UserModerationResult> => {
    const { id, action } = parse(adminModerateUserRequestSchema, input);
    return call("POST", `users/${segment(id)}/status`, { action });
  },
  "read-events": async (_req, input): Promise<ModerationEventPage> => {
    const query = parse(moderationEventQuerySchema, input ?? {});
    return call(
      "GET",
      `moderation-events${toQuery({
        subjectId: query.subjectId,
        action: query.action,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  },
  "read-summary": async (_req, input): Promise<ModerationSummary> => {
    const query = parse(moderationSummaryQuerySchema, input ?? {});
    return call("GET", `summary${toQuery({ range: query.range })}`);
  },
  // Work publishing (Development): the independent work publication policy
  // and limits, explicit submissions, account capacity and job outcomes.
  "read-work-publishing-settings": async (
    _req,
    input,
  ): Promise<WorkPublishingSettings> => {
    parse(noParameters, input);
    return checked(
      workPublishingSettingsSchema,
      await call("GET", "publishing/settings"),
    );
  },
  "set-work-publishing-settings": async (
    _req,
    input,
  ): Promise<WorkPublishingSettings> =>
    checked(
      workPublishingSettingsSchema,
      await call(
        "PUT",
        "publishing/settings",
        parse(setWorkPublishingSettingsCommandSchema, input),
      ),
    ),
  "read-work-submissions": async (
    _req,
    input,
  ): Promise<OperatorWorkSubmissionPage> => {
    const query = parse(operatorWorkSubmissionQuerySchema, input);
    return checked(
      operatorWorkSubmissionPageSchema,
      await call(
        "GET",
        `publishing/submissions${toQuery({
          state: query.state,
          page: query.page,
          pageSize: query.pageSize,
        })}`,
      ),
    );
  },
  "read-work-submission": async (
    _req,
    input,
  ): Promise<OperatorWorkSubmission> => {
    const { id } = parse(adminReadWorkSubmissionRequestSchema, input);
    return checked(
      operatorWorkSubmissionSchema,
      await call("GET", `publishing/submissions/${segment(id)}`),
    );
  },
  "moderate-work-submission": async (
    _req,
    input,
  ): Promise<WorkSubmissionModerationResult> => {
    const { id, ...command } = parse(
      adminModerateWorkSubmissionRequestSchema,
      input,
    );
    return checked(
      workSubmissionModerationResultSchema,
      await call(
        "POST",
        `publishing/submissions/${segment(id)}/moderation`,
        command,
      ),
    );
  },
  "read-account-capacity": async (
    _req,
    input,
  ): Promise<OperatorAccountCapacity> => {
    const { accountId } = parse(adminReadAccountCapacityRequestSchema, input);
    return checked(
      operatorAccountCapacitySchema,
      await call("GET", `publishing/accounts/${segment(accountId)}/capacity`),
    );
  },
  "set-account-capacity": async (
    _req,
    input,
  ): Promise<OperatorAccountCapacity> => {
    const { accountId, ...command } = parse(
      adminSetAccountCapacityClassRequestSchema,
      input,
    );
    return checked(
      operatorAccountCapacitySchema,
      await call(
        "PUT",
        `publishing/accounts/${segment(accountId)}/capacity`,
        command,
      ),
    );
  },
  "read-publishing-jobs": async (
    _req,
    input,
  ): Promise<OperatorPublishingJobPage> => {
    const query = parse(operatorPublishingJobQuerySchema, input);
    return checked(
      operatorPublishingJobPageSchema,
      await call(
        "GET",
        `publishing/jobs${toQuery({
          state: query.state,
          kind: query.kind,
          page: query.page,
          pageSize: query.pageSize,
        })}`,
      ),
    );
  },
  "retry-publishing-job": async (
    _req,
    input,
  ): Promise<OperatorPublishingJob> => {
    const { id, ...command } = parse(
      adminPublishingJobActionRequestSchema,
      input,
    );
    return checked(
      operatorPublishingJobSchema,
      await call("POST", `publishing/jobs/${segment(id)}/retry`, command),
    );
  },
  "abandon-publishing-job": async (
    _req,
    input,
  ): Promise<OperatorPublishingJob> => {
    const { id, ...command } = parse(
      adminPublishingJobActionRequestSchema,
      input,
    );
    return checked(
      operatorPublishingJobSchema,
      await call("POST", `publishing/jobs/${segment(id)}/abandon`, command),
    );
  },
});

const phase4Operations = new Set([
  "read-dm-conversation",
  "lookup-dm-conversation",
  "remove-dm-message",
  "read-threads",
  "create-thread",
  "update-thread",
  "read-users",
  "recommend-user",
  "read-works",
  "moderate-work",
  "read-featured",
  "set-featured",
  "set-featured-quantity",
  "delete-body",
  "remove-thread",
  "read-feature-catalogs",
  "read-work-publishing-settings",
  "set-work-publishing-settings",
  "read-work-submissions",
  "read-work-submission",
  "moderate-work-submission",
  "read-account-capacity",
  "set-account-capacity",
  "read-publishing-jobs",
  "retry-publishing-job",
  "abandon-publishing-job",
  // Agent administration (Issue #141 r3, Phase B) is Development-only too.
  ...agentAdminOperationNames,
]);

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
      if (phase4Operations.has(name) && process.env.NODE_ENV !== "development")
        throw new CommunityOperatorError("NOT_FOUND", 404);
      const input = await readJson(req);
      const result = await operation(req, input);
      return Response.json(
        { ok: true, result },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return failure(error, req);
    }
  },
});

/**
 * The Owner-only, Development-only binary relay for submission previews:
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
      if (process.env.NODE_ENV !== "development")
        throw new CommunityOperatorError("NOT_FOUND", 404);
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

/** The real endpoint set, with the transports injectable for boundary tests. */
export const createCommunityEndpoints = (
  call: OperatorCall = callCommunityOperator,
  openMedia: OperatorMediaCall = openCommunityOperatorMedia,
): Endpoint[] => [
  ...Object.entries({
    ...communityOperations(call),
    ...agentAdminOperations(call),
  }).map(([name, operation]) => endpoint(name, operation)),
  workSubmissionMediaEndpoint(openMedia),
];

export const communityEndpoints: Endpoint[] = createCommunityEndpoints();
