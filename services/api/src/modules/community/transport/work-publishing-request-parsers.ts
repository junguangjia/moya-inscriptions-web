import {
  createPublishingDraftCommandSchema,
  createPublishingSessionCommandSchema,
  mediaComponentIdSchema,
  mediaComponentRoleSchema,
  mediaEditKeySchema,
  mediaItemIdSchema,
  mediaVariantSchema,
  openWorkEditDraftCommandSchema,
  publishingDraftDeletionCommandSchema,
  publishingPageQuerySchema,
  publishingReadinessCommandSchema,
  publishingSessionHeartbeatCommandSchema,
  publishingSessionIdSchema,
  registerMediaItemCommandSchema,
  requestIdentitySchema,
  resolvePublishingConflictCommandSchema,
  restorePublishingSnapshotCommandSchema,
  savePublishingDraftCommandSchema,
  workDraftIdSchema,
  workPublishingFailureCodeSchema,
  workRevisionIdSchema,
  workSubmissionCommandSchema,
  workTimelineEntryCommandSchema,
  workVisibilityCommandSchema,
} from "@moya/contracts/schemas";

import {
  CommunityInputError,
  CommunityNotFoundError,
} from "../application/errors/community-request-errors.js";

/*
 * Transport parsing for work publishing (design §10). Runtime schemas stay
 * outside the application layer; the services receive strictly parsed
 * commands and well-formed route ids only.
 */

interface Parser<T> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error?: { readonly issues: unknown };
      };
}

const failureCodes: ReadonlySet<string> = new Set(
  workPublishingFailureCodeSchema.options,
);

/** Finds the first issue (nested union branches included) that names a failure code. */
const failureCodeInIssues = (issues: unknown): string | undefined => {
  if (!Array.isArray(issues)) return undefined;
  for (const issue of issues as unknown[]) {
    if (typeof issue !== "object" || issue === null) continue;
    const { message, errors } = issue as {
      readonly message?: unknown;
      readonly errors?: unknown;
    };
    if (typeof message === "string" && failureCodes.has(message))
      return message;
    if (Array.isArray(errors))
      for (const branch of errors as unknown[]) {
        const nested = failureCodeInIssues(branch);
        if (nested !== undefined) return nested;
      }
  }
  return undefined;
};

const pattern = (expression: RegExp): Parser<string> => ({
  safeParse: (input) =>
    typeof input === "string" && expression.test(input)
      ? { success: true, data: input }
      : { success: false },
});

const commandSchemas = {
  createDraft: createPublishingDraftCommandSchema,
  saveDraft: savePublishingDraftCommandSchema,
  deleteDraft: publishingDraftDeletionCommandSchema,
  openEditDraft: openWorkEditDraftCommandSchema,
  restoreSnapshot: restorePublishingSnapshotCommandSchema,
  resolveConflict: resolvePublishingConflictCommandSchema,
  createSession: createPublishingSessionCommandSchema,
  heartbeat: publishingSessionHeartbeatCommandSchema,
  requestIdentity: requestIdentitySchema,
  readiness: publishingReadinessCommandSchema,
  registerItem: registerMediaItemCommandSchema,
  submission: workSubmissionCommandSchema,
  visibility: workVisibilityCommandSchema,
  timelineEntry: workTimelineEntryCommandSchema,
  pageQuery: publishingPageQuerySchema,
} as const;

const segmentSchemas = {
  draftId: workDraftIdSchema,
  workId: pattern(/^work-[0-9a-f]{32}$/u),
  itemId: mediaItemIdSchema,
  componentId: mediaComponentIdSchema,
  sessionId: publishingSessionIdSchema,
  revisionId: workRevisionIdSchema,
  role: mediaComponentRoleSchema,
  variant: mediaVariantSchema,
  editKey: mediaEditKeySchema,
  requestId: pattern(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  ),
} as const;

export type WorkPublishingCommandKind = keyof typeof commandSchemas;
export type WorkPublishingSegmentKind = keyof typeof segmentSchemas;

type ParsedBy<S> = S extends {
  safeParse(input: unknown): infer R;
}
  ? R extends { readonly success: true; readonly data: infer T }
    ? T
    : never
  : never;

/**
 * Strict body or query parsing. A refinement whose message is a
 * `WorkPublishingFailureCode` becomes that code (answered as INVALID_INPUT
 * with the code); any other problem is a generic invalid input.
 */
export const parseWorkPublishingCommand = <K extends WorkPublishingCommandKind>(
  kind: K,
  input: unknown,
): ParsedBy<(typeof commandSchemas)[K]> => {
  const schema = commandSchemas[kind] as Parser<
    ParsedBy<(typeof commandSchemas)[K]>
  >;
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new CommunityInputError(
    failureCodeInIssues(result.error?.issues) ?? "invalid_input",
  );
};

/** A malformed route segment names nothing: it is unavailable, never a hint. */
export const parseWorkPublishingSegment = <K extends WorkPublishingSegmentKind>(
  kind: K,
  value: string | undefined,
): ParsedBy<(typeof segmentSchemas)[K]> => {
  const schema = segmentSchemas[kind] as Parser<
    ParsedBy<(typeof segmentSchemas)[K]>
  >;
  const result = schema.safeParse(value);
  if (!result.success) throw new CommunityNotFoundError();
  return result.data;
};
