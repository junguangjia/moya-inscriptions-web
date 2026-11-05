import {
  communityOperationDefinitions,
  type CommunityOperationName,
} from "../../community/endpoints";
import { COMMUNITY_READ_FACTS } from "./community-reads";
import { COMMUNITY_WRITE_FACTS } from "./community-writes";
import {
  asynchronous,
  example,
  irreversibleOp,
  readOp,
  reversibleOp,
  type AdminOpEntry,
} from "./define";

/** Per-target outcomes need single calls, so the bulk route has no op of its own. */
type CommunityOpRoute = Exclude<CommunityOperationName, "moderate-comments">;

const dm = { sensitive: "dm", tool: "admin_sensitive_read" } as const;

const rows: Readonly<Record<CommunityOpRoute, AdminOpEntry>> = {
  "read-reports": readOp("Report cases by status and urgency.", {
    example: { status: "open", page: 1, pageSize: 20 },
  }),
  "read-report": readOp(
    "One report case; claimant contact is never included.",
    {
      example: { id: example.report },
    },
  ),
  "decide-report": reversibleOp(
    "Decide an open case; its consequence runs with it.",
    "cas_read_back",
    {
      completion: asynchronous,
      example: {
        id: example.report,
        expectedVersion: 3,
        action: "hide",
        reason: example.reason,
      },
    },
  ),
  "review-report": reversibleOp(
    "Review an appealed decision: uphold or overturn.",
    "cas_read_back",
    {
      completion: asynchronous,
      example: {
        id: example.report,
        expectedVersion: 4,
        outcome: "uphold",
        reason: example.reason,
      },
    },
  ),
  "set-report-metadata": reversibleOp(
    "Set urgency, legal hold or status on a case.",
    "cas_read_back",
    {
      risesWhen: "legalHold is set to false",
      example: { id: example.report, expectedVersion: 3, urgent: true },
    },
  ),
  "forward-report": irreversibleOp(
    "Forward a notice, statement or result to the other party.",
    "cas_read_back",
    {
      example: {
        id: example.report,
        expectedVersion: 3,
        kind: "notice",
        text: "Synthetic notice",
      },
    },
  ),
  "read-feedback": readOp("User feedback, newest first.", {
    example: { page: 1, pageSize: 20 },
  }),
  "read-works": readOp("Works by search or author.", {
    example: { search: "synthetic", authorId: example.user },
  }),
  "read-users": readOp("Website users by search or id.", {
    example: { search: "synthetic" },
  }),
  "recommend-user": reversibleOp(
    "Turn a user's recommendation on or off.",
    "receipt",
    {
      example: {
        id: example.user,
        enabled: true,
        expectedVersion: 0,
      },
    },
  ),
  "moderate-work": reversibleOp(
    "Set a work visible, hidden or removed.",
    "receipt",
    {
      completion: asynchronous,
      selectorSources: ["list.works"],
      example: {
        id: example.work,
        state: "hidden",
        expectedVersion: 2,
        reason: example.reason,
      },
    },
  ),
  "read-featured": readOp("Featured Catalogs and works.", {
    example: { filter: "active" },
  }),
  "set-featured": reversibleOp(
    "Feature one Catalog or work, or stop featuring it.",
    "receipt",
    {
      example: {
        target: { type: "work", id: example.work },
        enabled: true,
        position: 0,
        expectedVersion: 0,
      },
    },
  ),
  "set-featured-quantity": reversibleOp(
    "Set how many featured rows the public list shows.",
    "receipt",
    {
      example: {
        enabledQuantity: 10,
        expectedVersion: 0,
      },
    },
  ),
  "delete-body": irreversibleOp("Delete a comment's body.", "receipt", {
    selectorSources: ["list.comments"],
    example: {
      id: example.comment,
      requestId: example.requestId,
      reason: example.reason,
    },
  }),
  "remove-thread": irreversibleOp(
    "Remove a comment thread; one target, whatever its replies.",
    "receipt",
    {
      selectorSources: ["list.comments"],
      example: {
        id: example.comment,
        requestId: example.requestId,
        reason: example.reason,
        expectedAffectedCount: 3,
      },
    },
  ),
  "read-dm-conversation": readOp(
    "One named direct-message conversation, with a stated purpose.",
    {
      ...dm,
      example: { id: example.conversation, purpose: "Synthetic purpose" },
    },
  ),
  "lookup-dm-conversation": readOp(
    "The conversation between two named users, with a stated purpose.",
    {
      ...dm,
      example: {
        userIds: [example.user, example.otherUser],
        purpose: "Synthetic purpose",
      },
    },
  ),
  "remove-dm-message": irreversibleOp(
    "Remove one direct message, with a stated purpose.",
    "receipt",
    {
      sensitive: "dm",
      example: {
        id: example.message,
        requestId: example.requestId,
        purpose: "Synthetic purpose",
      },
    },
  ),
  "read-threads": readOp("Operator-managed Threads.", {
    example: { includeHidden: true },
  }),
  "create-thread": reversibleOp("Create a Thread.", "receipt", {
    example: { title: "Synthetic thread" },
  }),
  "update-thread": reversibleOp(
    "Edit, close, hide or reorder a Thread.",
    "receipt",
    {
      example: {
        id: example.thread,
        expectedVersion: 1,
        status: "closed",
      },
    },
  ),
  "read-feature-catalogs": readOp("Published Catalogs that can be featured.", {
    example: { search: "synthetic" },
  }),
  "read-policy": readOp("The comment publication policy.", { example: {} }),
  "set-policy": reversibleOp(
    "Change the comment publication policy.",
    "receipt",
    { example: { policy: "PRE_MODERATION" } },
  ),
  "read-comments": readOp("Comments by moderation state, kind or Catalog.", {
    example: { moderation: "pending", order: "oldest" },
  }),
  "read-comment": readOp("One comment with its context.", {
    example: { id: example.comment },
  }),
  "moderate-comment": reversibleOp(
    "Approve, reject, hide or unhide one comment.",
    "receipt",
    {
      selectorSources: ["list.comments"],
      example: {
        id: example.comment,
        action: "hide",
        reason: example.reason,
      },
    },
  ),
  "moderate-user": reversibleOp("Suspend or reinstate a user.", "receipt", {
    completion: asynchronous,
    example: { id: example.user, action: "suspend", reason: example.reason },
  }),
  "read-events": readOp("The moderation history of a subject.", {
    example: { subjectId: example.comment },
  }),
  "read-summary": readOp("Moderation counts over a range.", {
    example: { range: "7d" },
  }),
  "read-work-publishing-settings": readOp(
    "The work publication policy and limits.",
    { example: {} },
  ),
  "set-work-publishing-settings": reversibleOp(
    "Change the work publication policy and limits.",
    "receipt",
    {
      example: {
        expectedVersion: 1,
        policy: "PRE_MODERATION",
        maxItemsPerWork: 9,
        originalItemMaxBytes: 104857600,
        standardComponentMaxBytes: 104857600,
        ordinaryAccountCapacityBytes: 1073741824,
        ownerAccountCapacityBytes: 10737418240,
        maxActiveDrafts: 20,
        dailyNewWorkLimit: 20,
        historyLimit: 50,
        trashRetentionDays: 30,
        orphanGraceDays: 7,
        unsavedSessionLeaseMinutes: 60,
      },
    },
  ),
  "read-article-submissions": readOp(
    "Author article submissions awaiting review.",
    {
      example: { pageSize: 20 },
    },
  ),
  "read-article-submission": readOp("One article submission.", {
    example: { id: example.article },
  }),
  "moderate-article-submission": reversibleOp(
    "Approve or reject an article submission.",
    "receipt",
    {
      completion: asynchronous,
      example: {
        id: example.article,
        expectedVersion: 1,
        candidateVersion: 1,
        fingerprint: example.digest,
        action: "approve",
        reason: example.reason,
      },
    },
  ),
  "read-work-submissions": readOp("Work submissions by state.", {
    example: { state: "pending" },
  }),
  "read-work-submission": readOp("One work submission.", {
    example: { id: example.revision },
  }),
  "moderate-work-submission": reversibleOp(
    "Approve or reject a work submission.",
    "receipt",
    {
      completion: asynchronous,
      example: {
        id: example.revision,
        action: "approve",
        expectedVersion: 1,
        reason: example.reason,
      },
    },
  ),
  "read-account-capacity": readOp("One account's publishing capacity.", {
    example: { accountId: example.user },
  }),
  "set-account-capacity": reversibleOp(
    "Set an account's capacity class.",
    "receipt",
    {
      example: {
        accountId: example.user,
        capacityClass: "ordinary",
        expectedVersion: 0,
      },
    },
  ),
  "read-publishing-jobs": readOp("Publishing jobs by state or kind.", {
    example: { state: "failed" },
  }),
  "retry-publishing-job": reversibleOp(
    "Retry a failed publishing job.",
    "receipt",
    {
      completion: asynchronous,
      selectorSources: ["list.jobs"],
      example: { id: example.job },
    },
  ),
  "abandon-publishing-job": irreversibleOp(
    "Abandon a publishing job; it will not run again.",
    "receipt",
    {
      selectorSources: ["list.jobs"],
      example: { id: example.job, requestId: example.requestId },
    },
  ),
};

type CommunityOps = {
  readonly [Route in CommunityOpRoute as `community.${Route}`]: AdminOpEntry;
};

/** A Payload read in Admin: this one route calls no Backend route at all. */
const CALLS_NO_BACKEND: ReadonlySet<CommunityOpRoute> = new Set([
  "read-feature-catalogs",
]);

/** Each row takes its input and output from the definition its route runs. */
export const communityOps = Object.fromEntries(
  (Object.entries(rows) as [CommunityOpRoute, AdminOpEntry][]).map(
    ([route, row]) => {
      const { input, output } = communityOperationDefinitions[route];
      const credential = CALLS_NO_BACKEND.has(route) ? "none" : "community";
      return [
        `community.${route}`,
        {
          ...row,
          credential,
          input,
          output,
          ...COMMUNITY_READ_FACTS[route],
          ...COMMUNITY_WRITE_FACTS[route],
        },
      ] as const;
    },
  ),
) as CommunityOps;
