import type {
  AdminActionSkeleton,
  AdminCmsRecordType,
  AdminLock,
  AdminMcpSensitiveCategory,
  AdminOpName,
  AdminRecordState,
  AdminRecordType,
} from "@moya/contracts/internal/admin-mcp";

import { built, none, notBuilt, type Unbuilt } from "./not-built";
import { adminOpMeta, opUnavailable } from "./registry";

/**
 * Prefilled skeletons, from this one function (admin-mcp-completion-v1 section 5):
 * an op appears once this key can really call it, so a slice that builds an op
 * offers it here with no change. `requestId` and the fields a caller decides are left
 * to the caller.
 */

export interface RecordFacts {
  readonly type: AdminCmsRecordType;
  readonly id: number;
  readonly state?: AdminRecordState;
  readonly revision?: number | null;
  readonly fingerprint?: string | null;
  readonly lock?: AdminLock | undefined;
  readonly catalogId?: string;
  readonly mediaId?: string;
}

export interface ActionScope {
  readonly tools: readonly string[];
  /** The caller's own account, the only holder a lock can be given back by. */
  readonly userId: number;
  readonly switches: Readonly<
    Partial<Record<AdminMcpSensitiveCategory, boolean>>
  >;
}

type Skeleton =
  | { readonly tool: string; readonly args: Record<string, unknown> }
  | {
      readonly op: AdminOpName;
      readonly input: Record<string, unknown>;
    };

const expectedOf = ({ revision, fingerprint }: RecordFacts) => ({
  revision,
  ...(fingerprint ? { fingerprint } : {}),
});

/** Only this caller's own lock is offered back: another account's refuses by name. */
const whenLocked = (
  { type, id, lock }: RecordFacts,
  userId: number,
): readonly Skeleton[] =>
  lock?.held
    ? [
        {
          op: "document.lock_takeover",
          input: {
            type,
            id,
            expected: {
              lockId: lock.lockId,
              holderUserId: lock.holderUserId,
              lastEditedAt: lock.lastEditedAt,
            },
          },
        },
        ...(lock.holderUserId === userId
          ? [{ op: "document.lock_release" as const, input: { type, id } }]
          : []),
      ]
    : [];

const publication = (
  family: "catalog" | "article" | "collection",
  facts: RecordFacts,
): readonly Skeleton[] => [
  ...(facts.state === "published"
    ? []
    : [
        {
          op: `${family}.publish` as AdminOpName,
          input: { id: facts.id, expected: expectedOf(facts) },
        },
      ]),
  ...(facts.state === "draft"
    ? []
    : [
        {
          op: `${family}.withdraw` as AdminOpName,
          input: { id: facts.id, expected: expectedOf(facts) },
        },
      ]),
];

const SKELETONS: Readonly<
  Record<
    AdminCmsRecordType,
    (facts: RecordFacts, userId: number) => readonly Skeleton[]
  >
> = {
  catalog: (facts, userId) => [
    {
      tool: "admin_get",
      args: { type: "catalog", id: facts.id, view: "preview" },
    },
    ...(facts.catalogId === undefined
      ? []
      : [
          {
            tool: "admin_read",
            args: {
              op: "list.media",
              input: { filter: { catalogId: facts.catalogId } },
            },
          },
        ]),
    {
      op: "catalog.patch_text",
      input: {
        catalogId: facts.id,
        field: "transcription",
        edits: [],
        expected: expectedOf(facts),
      },
    },
    {
      op: "editorial.save-draft",
      input: { id: facts.id, expectedRevision: facts.revision, content: {} },
    },
    ...publication("catalog", facts),
    ...whenLocked(facts, userId),
  ],
  article: (facts, userId) => [
    {
      tool: "admin_get",
      args: { type: "article", id: facts.id, view: "preview" },
    },
    {
      op: "editorial.save-article-draft",
      input: { id: facts.id, expectedRevision: facts.revision, content: {} },
    },
    ...publication("article", facts),
    ...whenLocked(facts, userId),
  ],
  collection: (facts, userId) => [
    {
      tool: "admin_get",
      args: { type: "collection", id: facts.id, view: "preview" },
    },
    {
      op: "collection.save",
      input: { id: facts.id, expected: expectedOf(facts) },
    },
    ...publication("collection", facts),
    ...whenLocked(facts, userId),
  ],
  media: (facts) => [
    ...(facts.mediaId === undefined
      ? []
      : [
          {
            tool: "admin_view_media",
            args: { kind: "catalog_thumb", mediaId: facts.mediaId },
          },
        ]),
    {
      op: "media.update_metadata",
      input: {
        id: facts.id,
        alt: "",
        expected: { fingerprint: facts.fingerprint },
      },
    },
  ],
};

/** Exact only. Filed under what can be called right now. */
export const actionsFor = (
  facts: RecordFacts,
  { tools, switches, userId }: ActionScope,
): readonly AdminActionSkeleton[] =>
  SKELETONS[facts.type](facts, userId).flatMap((skeleton) => {
    if ("tool" in skeleton)
      return tools.includes(skeleton.tool) ? [skeleton] : [];
    const entry = adminOpMeta[skeleton.op];
    return tools.includes(entry.tool) &&
      opUnavailable(entry, switches) === undefined
      ? [
          {
            tool: entry.tool,
            args: { op: skeleton.op, input: skeleton.input },
          },
        ]
      : [];
  });

/**
 * All a candidate ever carries: reading it. Use resolution.ref for a mutation, never
 * the first candidate, and this makes that the shape of the answer.
 */
export const candidateActions = (
  type: AdminRecordType,
  id: number | string,
): readonly AdminActionSkeleton[] => [
  { tool: "admin_get", args: { type, id } },
];

const queue = (op: AdminOpName, input: Record<string, unknown>) => ({
  tool: "admin_read",
  args: { op, input },
});

type Around = (id: string) => readonly AdminActionSkeleton[];

const CMS_SKELETONS = none("A CMS record: actionsFor files its skeletons.");

/** What reads around a community record. */
export const COMMUNITY_READS: Readonly<
  Record<AdminRecordType, Around | Unbuilt>
> = {
  catalog: CMS_SKELETONS,
  collection: CMS_SKELETONS,
  media: CMS_SKELETONS,
  article: none("Its outline names its owner."),
  thread: none("Its outline names no other record."),
  report: none("Its outline names its target and users."),
  feedback: none("Its outline names its user."),
  publishing_job: none("Its outline names its subject."),
  work_revision: none("Its outline names its work and author."),
  invitation: notBuilt("S10"),
  user: (id) => [
    queue("list.users", { userId: id }),
    queue("list.works", { authorId: id }),
    queue("list.comments", { authorId: id }),
    queue("list.reports", { affectedUserId: id }),
    queue("list.feedback", { userId: id }),
  ],
  work: (id) => [
    queue("list.reports", { targetType: "work", targetId: id }),
    queue("list.work_submissions", { workId: id }),
  ],
  comment: (id) => [
    queue("list.reports", { targetType: "comment", targetId: id }),
    queue("list.events", { subjectId: id }),
  ],
  media_item: (id) => [queue("list.jobs", { subjectId: id })],
};

const write = (op: AdminOpName, input: Record<string, unknown>) => ({
  tool: "admin_execute",
  args: { op, input },
});

/**
 * What can be done to it. `requestId`, a reason and a version stay the caller's. An
 * irreversible op joins with the run engine, through admin_preview.
 */
export const COMMUNITY_WRITES: Readonly<
  Record<AdminRecordType, Around | Unbuilt>
> = {
  catalog: CMS_SKELETONS,
  collection: CMS_SKELETONS,
  media: CMS_SKELETONS,
  feedback: none("No op writes feedback."),
  media_item: none("No op writes a media item; its jobs are publishing_job."),
  invitation: notBuilt("S10"),
  user: (id) => [write("community.moderate-user", { id })],
  work: (id) => [write("community.moderate-work", { id })],
  comment: (id) => [write("community.moderate-comment", { id })],
  report: (id) => [
    write("community.decide-report", { id }),
    write("community.review-report", { id }),
    write("community.set-report-metadata", { id }),
  ],
  thread: (id) => [write("community.update-thread", { id })],
  publishing_job: (id) => [write("community.retry-publishing-job", { id })],
  work_revision: (id) => [write("community.moderate-work-submission", { id })],
  article: (id) => [write("community.moderate-article-submission", { id })],
};

/**
 * Exact only, and on the tools this key has, so a read key is offered only reads. A
 * case only the Owner handles is offered no write, since each would answer that.
 */
export const communityActionsFor = (
  type: AdminRecordType,
  id: string,
  { tools }: Pick<ActionScope, "tools">,
  ownerOnly = false,
): readonly AdminActionSkeleton[] =>
  [
    ...candidateActions(type, id),
    ...(built(COMMUNITY_READS[type])?.(id) ?? []),
    ...(ownerOnly ? [] : (built(COMMUNITY_WRITES[type])?.(id) ?? [])),
  ].filter(({ tool }) => tools.includes(tool));
