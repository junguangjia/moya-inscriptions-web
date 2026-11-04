import {
  ADMIN_COMMUNITY_GET_VIEWS,
  adminCommunityGetDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminGetInput,
  AdminMcpEnvelope,
  AdminRecordType,
} from "@moya/contracts/internal/admin-mcp";
import { operatorExactIdSchema } from "@moya/contracts/internal/community-operator";
import type { PayloadRequest } from "payload";

import { communityOperationDefinitions } from "../../community/endpoints";
import type { CommunityOperationName } from "../../community/endpoints";
import { communityActionsFor } from "../actions-for";
import type { ActionScope } from "../actions-for";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import {
  askCommunity,
  askFind,
  communityRefusal,
  isOwnerOnly,
  SELF_ONLY_CATEGORY,
} from "../ops/community-reads";
import type { CommunityItem } from "../ops/community-reads";
import { factsOf, fieldTextOf, fullFieldOf } from "../records";
import type { FieldSpec } from "../records";
import { windowOfField } from "./get-window";

/**
 * admin_get on a community record (admin-mcp-completion-v1 section 6): the same
 * outline, whole-short-field and window answers as a CMS record, over what the
 * Backend's AI routes return. A nested value is read as its JSON, so its windows work
 * like any text. Every field is named here: what has no row cannot leave.
 */

const facts = (...names: readonly string[]): FieldSpec[] =>
  names.map((name) => ({ name, kind: "fact" }));
const texts = (...names: readonly string[]): FieldSpec[] =>
  names.map((name) => ({ name, kind: "text" }));
const arrays = (...names: readonly string[]): FieldSpec[] =>
  names.map((name) => ({ name, kind: "array" }));

const asJson = (value: unknown) =>
  value === null || value === undefined ? undefined : JSON.stringify(value);

const nested = (item: CommunityItem, name: string) =>
  (item[name] ?? {}) as CommunityItem;

interface CommunityRecord {
  readonly fields: readonly FieldSpec[];
  /** Names `self_only` on every answer, because the Backend withholds this record. */
  readonly excluded?: string;
  /** What the record is, read through the route its queue uses. */
  read(id: string, req: PayloadRequest): Promise<CommunityItem | undefined>;
  readonly state: (doc: CommunityItem) => string;
  readonly title?: (doc: CommunityItem) => unknown;
  readonly version?: (doc: CommunityItem) => unknown;
  readonly updatedAt?: (doc: CommunityItem) => unknown;
}

/** The input a route takes, or undefined for an id that can name no record. */
const parsedOr = (route: CommunityOperationName, input: unknown) => {
  const parsed = communityOperationDefinitions[route].input.safeParse(input);
  return parsed.success ? parsed.data : undefined;
};

const firstOfPage =
  (route: CommunityOperationName, filter: (id: string) => object) =>
  async (id: string, req: PayloadRequest) => {
    const parsed = parsedOr(route, { ...filter(id), pageSize: 1 });
    if (parsed === undefined) return undefined;
    const { items } = (await askCommunity(route, parsed, req)) as {
      readonly items: readonly CommunityItem[];
    };
    return items[0];
  };

const oneRecord =
  (route: CommunityOperationName) =>
  async (id: string, req: PayloadRequest) => {
    const parsed = parsedOr(route, { id });
    return parsed === undefined
      ? undefined
      : ((await askCommunity(route, parsed, req)) as CommunityItem);
  };

const RECORDS: Readonly<Partial<Record<AdminRecordType, CommunityRecord>>> = {
  report: {
    excluded: SELF_ONLY_CATEGORY,
    fields: [
      ...facts(
        "kind",
        "reason",
        "status",
        "urgent",
        "legalHold",
        "version",
        "createdAt",
        "updatedAt",
        "canonicalPath",
        "targetType",
        "targetId",
        "reporterId",
        "affectedUserId",
        "claimantName",
        "allowedActions",
        "notificationFailures",
      ),
      ...texts("description", "rightsBasis", "snapshot", "decision", "appeal"),
      ...arrays("materials", "messages", "history", "evidence"),
    ],
    read: async (id, req) => {
      const report = await oneRecord("read-report")(id, req);
      if (report === undefined || isOwnerOnly(report)) return report;
      return {
        ...report,
        targetType: nested(report, "target").type,
        targetId: nested(report, "target").id,
        claimantName: nested(report, "claimant").name,
        rightsBasis: nested(report, "claimant").rightsBasis,
        snapshot: asJson(report.snapshot),
        decision: asJson(report.decision),
        appeal: asJson(report.appeal),
      };
    },
    state: ({ status }) => String(status),
    title: ({ snapshot }) =>
      snapshot === undefined
        ? undefined
        : (JSON.parse(String(snapshot)) as { title?: unknown }).title,
    version: ({ version }) => version,
    updatedAt: ({ updatedAt }) => updatedAt,
  },
  user: {
    excluded: SELF_ONLY_CATEGORY,
    fields: [
      ...facts(
        "handle",
        "displayName",
        "status",
        "createdAt",
        "submittedWorks",
        "commentCount",
        "reportCount",
        "recommended",
        "recommendationVersion",
      ),
      ...texts("bio"),
    ],
    read: firstOfPage("read-users", (userId) => ({ userId })),
    state: ({ status }) => String(status),
    title: ({ displayName }) => displayName,
  },
  work: {
    excluded: SELF_ONLY_CATEGORY,
    fields: [
      ...facts(
        "state",
        "version",
        "authorId",
        "authorName",
        "authorStatus",
        "authorDeleted",
        "firstPublishedAt",
        "publicRevisionId",
        "publiclyVisible",
      ),
      ...texts("title", "text", "latestSubmission", "recommendation"),
    ],
    read: async (id, req) => {
      const work = await firstOfPage("read-works", (workId) => ({ workId }))(
        id,
        req,
      );
      return (
        work && {
          ...work,
          latestSubmission: asJson(work.latestSubmission),
          recommendation: asJson(work.recommendation),
        }
      );
    },
    state: ({ state }) => String(state),
    title: ({ title }) => (title === "" ? undefined : title),
    version: ({ version }) => version,
  },
  comment: {
    excluded: SELF_ONLY_CATEGORY,
    fields: [
      ...facts(
        "kind",
        "moderation",
        "authorId",
        "authorHandle",
        "authorName",
        "authorStatus",
        "catalogId",
        "targetType",
        "targetId",
        "rootCommentId",
        "replyToId",
        "contentTitle",
        "bodyDeleted",
        "threadRemoved",
        "threadAffectedCount",
        "imageCount",
        "createdAt",
        "parentRestriction",
      ),
      ...texts("text", "root", "replyTo", "analysis"),
      ...arrays("history"),
    ],
    read: async (id, req) => {
      const detail = await oneRecord("read-comment")(id, req);
      if (detail === undefined) return undefined;
      const item = nested(detail, "item");
      return {
        ...item,
        authorId: nested(item, "author").id,
        authorHandle: nested(item, "author").handle,
        authorName: nested(item, "author").displayName,
        authorStatus: nested(item, "author").status,
        targetType: nested(item, "target").type,
        targetId: nested(item, "target").id,
        contentTitle: item.contentTitle ?? item.catalogTitle,
        imageCount: Array.isArray(item.images) ? item.images.length : 0,
        parentRestriction: detail.parentRestriction,
        root: asJson(detail.root),
        replyTo: asJson(detail.replyTo),
        analysis: asJson(detail.analysis),
        history: detail.history,
      };
    },
    state: ({ moderation }) => String(moderation),
    title: ({ contentTitle }) => contentTitle,
  },
  thread: {
    fields: [
      ...facts(
        "title",
        "status",
        "hidden",
        "position",
        "version",
        "postCount",
        "tags",
        "createdBy",
        "createdAt",
        "updatedAt",
      ),
      ...texts("description"),
    ],
    read: firstOfPage("read-threads", (id) => ({ id })),
    state: ({ hidden, status }) =>
      hidden === true ? "hidden" : String(status),
    title: ({ title }) => title,
    version: ({ version }) => version,
    updatedAt: ({ updatedAt }) => updatedAt,
  },
  feedback: {
    fields: [
      ...facts("userId", "userName", "imageCount", "createdAt"),
      ...texts("message"),
    ],
    read: async (id, req) => {
      const row = await firstOfPage("read-feedback", (one) => ({ id: one }))(
        id,
        req,
      );
      return (
        row && {
          ...row,
          userId: nested(row, "user").id,
          userName: nested(row, "user").displayName,
          imageCount: Array.isArray(row.images) ? row.images.length : 0,
        }
      );
    },
    state: () => "received",
  },
  publishing_job: {
    fields: facts(
      "kind",
      "subjectId",
      "state",
      "attempts",
      "maxAttempts",
      "runAfter",
      "leaseExpiresAt",
      "lastErrorCode",
      "createdAt",
      "updatedAt",
      "finishedAt",
    ),
    read: firstOfPage("read-publishing-jobs", (id) => ({ id })),
    state: ({ state }) => String(state),
    updatedAt: ({ updatedAt }) => updatedAt,
  },
  work_revision: {
    excluded: SELF_ONLY_CATEGORY,
    fields: [
      ...facts(
        "workId",
        "sequence",
        "origin",
        "authorId",
        "authorHandle",
        "disposition",
        "latest",
        "workState",
        "workTrashed",
        "coverItemId",
        "submittedAt",
        "decidedAt",
        "decidedBy",
        "version",
      ),
      ...texts("title", "body", "authorship"),
      ...arrays("items"),
    ],
    read: async (id, req) => {
      const revision = await oneRecord("read-work-submission")(id, req);
      return (
        revision && {
          ...revision,
          authorId: nested(revision, "author").id,
          authorHandle: nested(revision, "author").handle,
          authorship: asJson(revision.authorship),
        }
      );
    },
    state: ({ disposition }) => String(disposition),
    title: ({ title }) => title,
    version: ({ version }) => version,
  },
  media_item: {
    excluded: SELF_ONLY_CATEGORY,
    fields: facts("state", "kind", "ownerId", "updatedAt"),
    read: async (id) => {
      const { items } = await askFind({ type: "media_item", id });
      const item = items[0];
      return (
        item && {
          state: item.state,
          updatedAt: item.updatedAt,
          ...item.disambiguators,
        }
      );
    },
    state: ({ state }) => String(state),
    updatedAt: ({ updatedAt }) => updatedAt,
  },
  // An Article's working copy is the author's own: only a pending candidate is read.
  article: {
    excluded: "private_draft",
    fields: [
      ...facts("status", "ownerId", "title", "version", "updatedAt"),
      ...facts("candidateVersion", "fingerprint", "publicVersion"),
      ...texts("document"),
    ],
    read: async (id, req) => {
      const { items } = await askFind({ type: "article", id });
      const found = items[0];
      if (found === undefined) return undefined;
      const facts = {
        status: found.state,
        title: found.title,
        version: found.version,
        updatedAt: found.updatedAt,
        ownerId: found.disambiguators.ownerId,
      };
      if (found.state !== "pending") return facts;
      const candidate = (await askCommunity(
        "read-article-submission",
        { id },
        req,
      )) as CommunityItem;
      return {
        ...facts,
        candidateVersion: candidate.candidateVersion,
        fingerprint: candidate.fingerprint,
        publicVersion: candidate.publicVersion,
        document: asJson(candidate.document),
      };
    },
    state: ({ status }) => String(status),
    title: ({ title }) => title,
    version: ({ version }) => version,
    updatedAt: ({ updatedAt }) => updatedAt,
  },
};

const ARTICLE_ID = /^article-[0-9a-f]{32}$/u;

/** An Article id with no CMS row can be one the community side holds. */
export const isCommunityArticleId = ({ type, id }: AdminGetInput): boolean =>
  type === "article" && typeof id === "string" && ARTICLE_ID.test(id);

export const communityFieldNames = (type: AdminRecordType): readonly string[] =>
  RECORDS[type]?.fields.map(({ name }) => name) ?? [];

const unknownField = (record: CommunityRecord, path: string) =>
  inputInvalidEnvelope([
    {
      path: [path],
      code: "unknown_field",
      allowedKeys: record.fields.map(({ name }) => name),
    },
  ]);

const answered = (data: unknown, untrusted: readonly string[]) =>
  okEnvelope(adminCommunityGetDataSchema.parse(data), untrusted);

const OUTLINE_UNTRUSTED = ["/data/title", "/data/fields/*/value"];

const ofType = (type: "string" | "number", value: unknown) =>
  typeof value === type ? value : undefined;

const withoutEmpty = (values: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );

export const communityGetEnvelope = async (
  req: PayloadRequest,
  input: AdminGetInput,
  scope: ActionScope,
): Promise<AdminMcpEnvelope> => {
  const record = RECORDS[input.type];
  // Withheld or unbuilt is never the same answer as nothing being there.
  if (record === undefined) return failedEnvelope("NOT_AVAILABLE");
  const named = (envelope: AdminMcpEnvelope): AdminMcpEnvelope =>
    record.excluded === undefined
      ? envelope
      : {
          ...envelope,
          meta: { ...envelope.meta, excluded: [record.excluded] },
        };
  const view =
    input.view ?? ((input.field ?? input.find) ? "field" : "outline");
  if (!(ADMIN_COMMUNITY_GET_VIEWS as readonly string[]).includes(view))
    return inputInvalidEnvelope([
      {
        path: ["view"],
        code: "view_not_supported",
        allowedKeys: [...ADMIN_COMMUNITY_GET_VIEWS],
      },
    ]);
  const known = new Set(record.fields.map(({ name }) => name));
  if (input.fields?.some((name) => !known.has(name)))
    return unknownField(record, "fields");
  // A number is a CMS row id, and PostgreSQL text cannot hold a NUL.
  const id = operatorExactIdSchema.safeParse(input.id);
  if (!id.success) return named(failedEnvelope("NOT_FOUND"));
  let doc: CommunityItem | undefined;
  try {
    doc = await record.read(id.data, req);
  } catch (error) {
    return named(communityRefusal(error));
  }
  if (doc === undefined) return named(failedEnvelope("NOT_FOUND"));
  if (isOwnerOnly(doc))
    return named(failedEnvelope("SELF_ONLY_OWNER_REVIEW", { data: doc }));
  const common = {
    type: input.type,
    id: id.data,
    view,
    readFrom: "live",
    state: record.state(doc),
    ...withoutEmpty({
      version: ofType("number", record.version?.(doc)),
      title: ofType("string", record.title?.(doc)),
      updatedAt: ofType("string", record.updatedAt?.(doc)),
    }),
  };
  const redacted = (doc as { redacted?: string[] }).redacted;
  const told = (envelope: AdminMcpEnvelope): AdminMcpEnvelope =>
    named(
      redacted === undefined
        ? envelope
        : { ...envelope, meta: { ...envelope.meta, redacted } },
    );
  if (view === "field") {
    if (input.field === undefined)
      return inputInvalidEnvelope([{ path: ["field"], code: "required" }]);
    const located = fieldTextOf(record, doc, input.field);
    if (!located.found || located.withheld)
      return unknownField(record, "field");
    return told(windowOfField(common, input, located, answered));
  }
  const specs = record.fields.filter(
    ({ name }) => input.fields === undefined || input.fields.includes(name),
  );
  return told(
    answered(
      {
        ...common,
        actions: [...communityActionsFor(input.type, id.data, scope)],
        lengthUnit: "codePoint",
        fields: specs.map((spec) =>
          view === "full" ? fullFieldOf(spec, doc) : factsOf(spec, doc),
        ),
      },
      OUTLINE_UNTRUSTED,
    ),
  );
};
