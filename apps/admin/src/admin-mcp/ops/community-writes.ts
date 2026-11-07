import {
  AI_OPERATOR_LABEL,
  AI_OPERATOR_REQUEST_ID_HEADER,
  adminCommunityWriteEchoSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminJobRef,
  AiSettlementQuery,
} from "@moya/contracts/internal/admin-mcp";
import type { z } from "zod";

import { CommunityOperatorError } from "../../community/backend";
import {
  communityOperationDefinitions,
  type CommunityOperationName,
} from "../../community/endpoints";
import { BACKEND_CONTRACT_MISMATCH } from "../backend-answer";
import { okEnvelope } from "../envelope";
import { notBuilt, type Unbuilt } from "../not-built";
import { settledBy } from "../settlement";
import type { CommunityOpRoute } from "./community";
import {
  askCommunity,
  backendAnswer,
  COMMUNITY_CODE_HERE,
  communityWriteCall,
  isOwnerOnly,
  shortOrFacts,
  type CommunityItem,
  type CommunityReadRoute,
} from "./community-reads";
import { onField, requestKeyOf } from "./define";
import type { AdminOpContext, AdminOpEntry } from "./define";

/**
 * The community's reversible writes on admin_execute (admin-mcp-completion-v1 section
 * 7), through the route each human page already uses, on the AI credential, so the
 * Backend's services do the work and label it `ai-admin`. A write with a receipt
 * replays by its key. One guarded by a version has none, so a repeat that conflicts
 * reads the record and asks whether this command is what moved it.
 */

/** Nothing ran on these, whatever their status says. */
const NOTHING_RAN: ReadonlySet<string> = new Set([
  "AI_CREDENTIAL_NOT_CONFIGURED",
  "OPERATOR_NOT_CONFIGURED",
  "EXECUTE_BUSY",
]);

/**
 * What a Backend refusal says about one target. Past a 5xx or a lost answer the write
 * may have committed, so it reads as unknown and never as a refusal. An answer that
 * cannot be read says so by name, because a repeat reads the same answer. Anything else
 * keeps its bare code, or the one it has here, so a bad input answers a named refusal.
 */
const writeFailure = (error: unknown): unknown => {
  if (!(error instanceof CommunityOperatorError)) return error;
  const { code, status } = error;
  if (NOTHING_RAN.has(code) || code === BACKEND_CONTRACT_MISMATCH)
    return new Error(code);
  const here = COMMUNITY_CODE_HERE[code];
  if (here !== undefined) return new Error(here);
  if (status >= 500) return new Error("OUTCOME_UNKNOWN");
  if (status === 404) return new Error("NOT_FOUND");
  if (status === 401) return new Error("AI_ROUTE_FORBIDDEN");
  return new Error(code);
};

const isStateConflict = (error: unknown) =>
  error instanceof CommunityOperatorError && error.code === "STATE_CONFLICT";

/** Nothing shows what this command did, so it is not read as having done nothing. */
const readBackFailed = () => new Error("OUTCOME_UNKNOWN");

interface WriteAnswer {
  readonly answer: CommunityItem;
  readonly replayed: boolean;
}

/**
 * One route's write, under this target's key. The route's own command takes it in its
 * body, or in a header when it has no such field. Checked against what the route
 * answers once the words only AI is told are off it.
 */
const sendWrite = async (
  route: CommunityOperationName,
  raw: unknown,
  context: AdminOpContext,
): Promise<WriteAnswer> => {
  const definition = communityOperationDefinitions[route];
  const key = requestKeyOf(context);
  const shape = (definition.input as z.ZodObject).shape;
  const parsed = definition.input.parse(
    "requestId" in shape ? { ...(raw as object), requestId: key } : raw,
  );
  const answered = (await definition.run(
    parsed,
    communityWriteCall(
      "requestId" in shape ? {} : { [AI_OPERATOR_REQUEST_ID_HEADER]: key },
    ),
    context.req,
  )) as CommunityItem;
  const { replayed, alreadyInPlace, ...sent } = answered;
  const schema = definition.output.ai ?? definition.output.owner;
  // As sent, less any key the schema does not name.
  const answer =
    schema === undefined
      ? sent
      : (backendAnswer(schema, sent).kept as CommunityItem);
  // The effect was there already, so this call changed nothing and opened no case.
  if (alreadyInPlace === true) throw new Error("ALREADY_SET");
  return { answer, replayed: replayed === true };
};

type Echo = (answer: CommunityItem) => Record<string, unknown>;

/** Runs the op, and answers the row `results` shows. A replay opens no case. */
const written =
  (route: CommunityOperationName, echo: Echo, opensCase = false) =>
  async (raw: unknown, context: AdminOpContext) => {
    try {
      const { answer, replayed } = await sendWrite(route, raw, context);
      return okEnvelope({
        ...echo(answer),
        ...(replayed
          ? { replayed: true }
          : opensCase
            ? { caseOpened: true }
            : {}),
      });
    } catch (error) {
      throw writeFailure(error);
    }
  };

const nested = (item: CommunityItem, name: string) =>
  (item[name] ?? {}) as CommunityItem;

/** `target`, its source and `affectedUserId` name what a decision acts on and settles. */
const reportEcho: Echo = (report) => ({
  id: report.id,
  state: report.status,
  version: report.version,
  kind: report.kind,
  urgent: report.urgent,
  legalHold: report.legalHold,
  target: report.target,
  targetSource: nested(report, "snapshot").source,
  affectedUserId: report.affectedUserId,
  decision:
    report.decision === null
      ? null
      : {
          id: nested(report, "decision").id,
          action: nested(report, "decision").action,
          reversedAt: nested(report, "decision").reversedAt,
        },
  appeal: nested(report, "appeal").status ?? null,
});

/**
 * Whether the record already shows this command, by `ai-admin`. Past that a conflict is
 * what it says: someone moved the record, and it wants reading again.
 */
type ShowsCommand = (
  report: CommunityItem,
  command: Readonly<Record<string, unknown>>,
) => boolean;

type HistoryRow = {
  readonly operator: string;
  readonly action: string;
  readonly reason: string;
};

const historyOf = (report: CommunityItem) =>
  (report.history ?? []) as readonly HistoryRow[];

/** A prefix can stand before the reason: an official record's verification says so. */
const showsReason = (
  report: CommunityItem,
  action: unknown,
  reason: unknown,
): boolean =>
  historyOf(report).some(
    (row) =>
      row.operator === AI_OPERATOR_LABEL &&
      row.action === action &&
      typeof reason === "string" &&
      row.reason.endsWith(reason),
  );

const showsDecision: ShowsCommand = (report, { action, reason }) => {
  const decision = nested(report, "decision");
  return (
    decision.action === action &&
    decision.reversedAt === null &&
    showsReason(report, action, reason)
  );
};

const showsReview: ShowsCommand = (report, { outcome, reason }) =>
  (nested(report, "decision").reversedAt !== null) ===
    (outcome === "overturn") && showsReason(report, outcome, reason);

/** Its audit row holds the command as sent, version included, so this is the very one. */
const showsMetadata: ShowsCommand = (report, command) => {
  const sent = Object.entries(command).filter(([name]) => name !== "id");
  return historyOf(report).some((row) => {
    if (row.operator !== AI_OPERATOR_LABEL || row.action !== "metadata")
      return false;
    try {
      const stored = JSON.parse(row.reason) as CommunityItem;
      return (
        Object.keys(stored).length === sent.length &&
        sent.every(([name, value]) => stored[name] === value)
      );
    } catch {
      return false;
    }
  });
};

/** A report's write. Its expected version has moved after a commit whose answer was lost. */
const reportWrite =
  (route: CommunityOperationName, shows: ShowsCommand) =>
  async (raw: unknown, context: AdminOpContext) => {
    try {
      const { answer } = await sendWrite(route, raw, context);
      return okEnvelope(reportEcho(answer));
    } catch (error) {
      if (!isStateConflict(error)) throw writeFailure(error);
      const command = communityOperationDefinitions[route].input.parse(raw) as {
        id: string;
      } & Record<string, unknown>;
      let report: CommunityItem;
      try {
        report = (await askCommunity(
          "read-report",
          { id: command.id },
          context.req,
        )) as CommunityItem;
      } catch (failure) {
        // A replay would read the same unreadable answer, so that one is named.
        throw failure instanceof CommunityOperatorError &&
          failure.code === BACKEND_CONTRACT_MISMATCH
          ? new Error(BACKEND_CONTRACT_MISMATCH)
          : readBackFailed();
      }
      if (isOwnerOnly(report) || !shows(report, command))
        throw writeFailure(error);
      return okEnvelope({ ...reportEcho(report), replayed: true });
    }
  };

const withoutKey = (route: CommunityOperationName) => {
  const { input } = communityOperationDefinitions[route];
  const object = input as z.ZodObject;
  return "requestId" in object.shape ? object.omit({ requestId: true }) : input;
};

const write = (
  route: CommunityOperationName,
  target: NonNullable<AdminOpEntry["target"]>,
  run: NonNullable<AdminOpEntry["run"]>,
  untrusted: readonly string[] = [],
): Partial<AdminOpEntry> => ({
  input: withoutKey(route),
  output: { ai: adminCommunityWriteEchoSchema },
  target,
  run,
  untrusted,
});

const TITLE = ["/data/results/*/title"];

const threadEcho: Echo = (thread) => ({
  id: thread.id,
  title: shortOrFacts(thread.title),
  state: thread.hidden === true ? "hidden" : thread.status,
  version: thread.version,
});

/**
 * A timeline row's id is its writer's own text, so the echo leaves it out and the
 * answer names the row by its index, as it does any id that is not a fixed shape.
 */
const timelineEcho: Echo = (entry) => ({
  title: shortOrFacts(entry.title),
  state: entry.hidden === true ? "hidden" : "visible",
  version: entry.version,
  linkState: entry.linkState,
});

const onTimelineEntry = onField("timeline_entry", "id");

const onReport = onField("report", "id");

/** These change no one's media: a warning, or comments restricted for the future. */
const MOVES_NO_MEDIA: ReadonlySet<unknown> = new Set([
  "retain",
  "warn",
  "restrict_comments",
]);

/**
 * A rule that cannot say what a committed command moved. It never reads as nothing
 * moved: settlement catches this and the target stays QUEUED, as unread.
 */
const subjectUnknown = () => new Error("SETTLEMENT_SUBJECT_UNKNOWN");

/**
 * What a case's decision acts on, as the reporting adapter's own subject rule has it. A
 * work or a community Article moves media, and a suspension moves all of its user's. An
 * official record's hide is verified before its decision, and it queues nothing here.
 */
const decisionRef = (
  report: CommunityItem,
  action: unknown,
  intent: AiSettlementQuery["intent"],
): AdminJobRef | null => {
  if (action === undefined) throw subjectUnknown();
  if (MOVES_NO_MEDIA.has(action)) return null;
  if (action === "suspend") {
    if (typeof report.affectedUserId !== "string") throw subjectUnknown();
    return { type: "user", id: report.affectedUserId, intent };
  }
  const { type, id } = nested(report, "target") as {
    type?: unknown;
    id?: string;
  };
  if (id === undefined) throw subjectUnknown();
  if (type === "work") return { type, id, intent };
  return type === "article" && report.targetSource === "community"
    ? { type, id, intent }
    : null;
};

const RESTORES: ReadonlySet<unknown> = new Set(["approve", "restore"]);

type Moderation = Readonly<Record<string, unknown>>;

/** What an AI command asked of the media, from the words its route takes. */
const onWork = settledBy(
  ({ id, state }: { id: string; state: string }): AdminJobRef => ({
    type: "work",
    id,
    intent: state === "visible" ? "publish" : "withdraw",
  }),
);

const onUser = settledBy(
  ({ id, action }: { id: string; action: string }): AdminJobRef => ({
    type: "user",
    id,
    intent: action === "suspend" ? "withdraw" : "publish",
  }),
);

/** A submission's answer names its work, and the command names only the revision. */
const onSubmission = settledBy(
  ({ action }: { action: string }, result?: Moderation): AdminJobRef => {
    if (typeof result?.workId !== "string") throw subjectUnknown();
    return {
      type: "work",
      id: result.workId,
      intent: action === "approve" ? "publish" : "withdraw",
    };
  },
);

const onArticle = settledBy(
  ({ id, action }: { id: string; action: string }): AdminJobRef => ({
    type: "article",
    id,
    intent: action === "approve" ? "publish" : "withdraw",
  }),
);

const onDecision = settledBy(
  ({ action }: Moderation, result?: CommunityItem): AdminJobRef | null => {
    if (result === undefined) throw subjectUnknown();
    return decisionRef(
      result,
      action,
      RESTORES.has(action) ? "publish" : "withdraw",
    );
  },
);

/**
 * A review acts on the decision before it. Overturned, what that decision withdrew comes
 * back. Upheld, nothing moves, and what the decision queued is still what is awaited.
 */
const onReview = settledBy(
  ({ outcome }: Moderation, result?: CommunityItem): AdminJobRef | null => {
    if (result === undefined) throw subjectUnknown();
    const { action } = nested(result, "decision");
    return decisionRef(
      result,
      action,
      RESTORES.has(action) === (outcome === "overturn")
        ? "withdraw"
        : "publish",
    );
  },
);

const onJob = settledBy(({ id }: { id: string }): AdminJobRef => ({
  type: "publishing_job",
  id,
}));

/** Every route of an op that is not a read. */
export type CommunityWriteRoute = Exclude<CommunityOpRoute, CommunityReadRoute>;

/** What each built write adds to its row, or which slice brings it. */
export const COMMUNITY_WRITE_FACTS: Readonly<
  Record<CommunityWriteRoute, Partial<AdminOpEntry> | Unbuilt>
> = {
  "decide-report": {
    ...write(
      "decide-report",
      onReport,
      reportWrite("decide-report", showsDecision),
    ),
    completion: onDecision,
  },
  "review-report": {
    ...write(
      "review-report",
      onReport,
      reportWrite("review-report", showsReview),
    ),
    completion: onReview,
  },
  "set-report-metadata": {
    ...write(
      "set-report-metadata",
      onReport,
      reportWrite("set-report-metadata", showsMetadata),
    ),
    classify: async (input) =>
      (input as { legalHold?: unknown }).legalHold === false
        ? "irreversible"
        : "reversible",
  },
  "moderate-comment": write(
    "moderate-comment",
    onField("comment", "id"),
    written(
      "moderate-comment",
      (answer) => ({ id: answer.id, state: answer.moderation }),
      true,
    ),
  ),
  "moderate-user": {
    ...write(
      "moderate-user",
      onField("user", "id"),
      written(
        "moderate-user",
        (answer) => ({
          id: answer.id,
          state: answer.status,
          revokedSessions: answer.revokedSessions,
        }),
        true,
      ),
    ),
    completion: onUser,
  },
  "moderate-work": {
    ...write(
      "moderate-work",
      onField("work", "id"),
      written(
        "moderate-work",
        (work) => ({
          id: work.id,
          title: shortOrFacts(work.title),
          state: work.state,
          version: work.version,
          publiclyVisible: work.publiclyVisible,
        }),
        true,
      ),
      TITLE,
    ),
    completion: onWork,
  },
  "moderate-work-submission": {
    ...write(
      "moderate-work-submission",
      onField("work_revision", "id"),
      written(
        "moderate-work-submission",
        ({ revisionId, workId, disposition, version }) => ({
          id: revisionId,
          workId,
          state: disposition,
          version,
        }),
        true,
      ),
    ),
    completion: onSubmission,
  },
  "moderate-article-submission": {
    ...write(
      "moderate-article-submission",
      onField("article", "id"),
      written(
        "moderate-article-submission",
        ({ articleId, disposition, status, version, publicVersion }) => ({
          id: articleId,
          state: disposition,
          status,
          version,
          publicVersion,
        }),
        true,
      ),
    ),
    completion: onArticle,
  },
  "recommend-user": write(
    "recommend-user",
    onField("user", "id"),
    written("recommend-user", ({ version }) => ({ version })),
  ),
  "set-featured": write(
    "set-featured",
    (input) => {
      const { target } = input as { target?: { type?: unknown; id?: unknown } };
      return {
        type: `featured_${String(target?.type)}`,
        ...(target?.id === undefined ? {} : { id: String(target.id) }),
      };
    },
    written("set-featured", ({ version }) => ({ version })),
  ),
  "set-featured-quantity": write(
    "set-featured-quantity",
    () => ({ type: "featured_settings" }),
    written("set-featured-quantity", ({ version }) => ({ version })),
  ),
  "create-thread": write(
    "create-thread",
    () => ({ type: "thread" }),
    written("create-thread", threadEcho),
    TITLE,
  ),
  "update-thread": write(
    "update-thread",
    onField("thread", "id"),
    written("update-thread", threadEcho),
    TITLE,
  ),
  "set-policy": write(
    "set-policy",
    () => ({ type: "comment_policy" }),
    written("set-policy", ({ policy, updatedBy, updatedAt }) => ({
      state: policy,
      updatedBy,
      updatedAt,
    })),
  ),
  "set-work-publishing-settings": write(
    "set-work-publishing-settings",
    () => ({ type: "work_publishing_settings" }),
    written("set-work-publishing-settings", (settings) => settings),
  ),
  "set-account-capacity": write(
    "set-account-capacity",
    onField("user", "accountId"),
    written("set-account-capacity", (capacity) => capacity),
  ),
  // Accepted never reads as done, and how far it got is the job's own state, read by
  // its settlement: this echo holds only what stays true of the job.
  "retry-publishing-job": {
    ...write(
      "retry-publishing-job",
      onField("publishing_job", "id"),
      written("retry-publishing-job", ({ id, kind, subjectId }) => ({
        id,
        kind,
        subjectId,
      })),
    ),
    completion: onJob,
  },
  "create-timeline-entry": write(
    "create-timeline-entry",
    onTimelineEntry,
    written("create-timeline-entry", timelineEcho),
    TITLE,
  ),
  "update-timeline-entry": write(
    "update-timeline-entry",
    onTimelineEntry,
    written("update-timeline-entry", timelineEcho),
    TITLE,
  ),
  // One target, many rows: a year's order moves all at once or not at all.
  "reorder-timeline": write(
    "reorder-timeline",
    () => ({ type: "timeline_year" }),
    written("reorder-timeline", ({ startYear, count }) => ({
      startYear,
      count,
    })),
  ),
  // Irreversible: preview, then admin_execute_irreversible, with the run engine. Their
  // routes have no AI row until then.
  "forward-report": notBuilt("S8"),
  "delete-body": notBuilt("S8"),
  "remove-thread": notBuilt("S8"),
  "abandon-publishing-job": notBuilt("S8"),
  // Behind the dm switch.
  "remove-dm-message": notBuilt("S13"),
};
