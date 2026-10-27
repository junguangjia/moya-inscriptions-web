import {
  bulkModerateCommentsCommandSchema,
  moderateCommentCommandSchema,
  moderateUserCommandSchema,
  moderationEventPageSchema,
  moderationEventQuerySchema,
  moderationSummaryQuerySchema,
  moderationSummarySchema,
  operatorCommentDetailSchema,
  operatorCommentPageSchema,
  operatorCommentQuerySchema,
  operatorLabelSchema,
  publicationPolicyStateSchema,
  setPublicationPolicyCommandSchema,
} from "@moya/contracts/internal/community-operator";

import {
  CommunityConflictError,
  CommunityInputError,
  CommunityNotFoundError,
  isCommunityConflictError,
  isCommunityNotFoundError,
} from "../errors/community-request-errors.js";
import { isCommunityStoreUnavailableError } from "../errors/community-store-unavailable-error.js";
import { DisabledCommentAnalysisPort } from "../ports/comment-analysis-port.js";
import { defaultRandomBytes, generateOpaqueId } from "../session-token.js";

import type {
  CatalogCommentId,
  CatalogId,
  PublicUserId,
} from "@moya/contracts";
import type {
  BulkModerationResult,
  CommentModerationAction,
  CommentModerationState,
  ModerationEvent as ModerationEventDto,
  ModerationEventPage,
  ModerationResult,
  ModerationSummary,
  ModerationSummaryRange,
  OperatorComment,
  OperatorCommentDetail,
  OperatorCommentPage,
  ParentRestriction,
  PublicationPolicyState,
  UserModerationResult,
} from "@moya/contracts/internal/community-operator";
import type { CatalogPublicationPort } from "../ports/catalog-publication-port.js";
import type { CommentAnalysisPort } from "../ports/comment-analysis-port.js";
import type {
  CommunityCommentPort,
  ModerationEvent,
  ModerationEventAction,
  ModerationEventDraft,
  OperatorCommentRecord,
} from "../ports/community-comment-port.js";
import type { CommunityIdentityPort } from "../ports/community-identity-port.js";
import type { RandomBytes } from "../session-token.js";

import type {
  CommandReceipt,
  ModeratedSubject,
} from "../ports/community-comment-port.js";
import type { CommunityContentOperatorPort } from "../ports/community-content-operator-port.js";
export interface CommunityModerationServiceOptions {
  readonly contentOperatorPort?: CommunityContentOperatorPort;
  readonly clock?: () => Date;
  readonly randomBytes?: RandomBytes;
  /**
   * Recorded on every action. It is server configuration, never a value a
   * browser or an Admin request supplies, and never a PublicUserId or a
   * Payload row id. A future automation principal gets its own label so a
   * machine action can never be recorded as the Owner's.
   */
  readonly operatorLabel?: string;
  /** Advisory analysis; absent means "not connected", never "clean". */
  readonly analysisPort?: CommentAnalysisPort;
}

const defaultOperatorLabel = "owner";
const defaultOperatorPageSize = 20;
const detailHistoryLimit = 50;
const summaryRangeMs: Record<ModerationSummaryRange, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
};

/**
 * The comment state machine, edge by edge: approve (pending -> visible),
 * reject (pending -> hidden, its own audited action so a refusal is never
 * confused with a takedown), hide (visible -> hidden), unhide (hidden ->
 * visible). Nothing else, and nothing deletes.
 */
const moderationTransitions: Record<
  CommentModerationAction,
  {
    readonly to: CommentModerationState;
    readonly from: CommentModerationState[];
  }
> = {
  approve: { to: "visible", from: ["pending"] },
  reject: { to: "hidden", from: ["pending"] },
  hide: { to: "hidden", from: ["visible"] },
  unhide: { to: "visible", from: ["hidden"] },
};

const isoUtc = (value: Date): string =>
  value.toISOString().replace(/\.\d{3}Z$/, ".000Z");

const toEventDto = (event: ModerationEvent): ModerationEventDto => ({
  id: event.id,
  occurredAt: isoUtc(event.occurredAt),
  operatorLabel: event.operatorLabel,
  action: event.action,
  subjectKind: event.subjectKind,
  subjectId: event.subjectId,
  ...(event.detail === undefined ? {} : { detail: event.detail }),
});

/**
 * The Owner's moderation surface behind the authenticated operator boundary.
 * The Backend stays the sole writer of community data; Payload Admin is only
 * a client of these operations, and so will any later REST or MCP adapter be.
 */
export class CommunityModerationService {
  private readonly clock: () => Date;
  private readonly randomBytes: RandomBytes;
  private readonly operatorLabel: string;
  private readonly analysisPort: CommentAnalysisPort;
  private readonly contentOperatorPort:
    CommunityContentOperatorPort | undefined;

  constructor(
    private readonly commentPort: CommunityCommentPort,
    private readonly identityPort: CommunityIdentityPort,
    private readonly catalogPort: CatalogPublicationPort,
    options: CommunityModerationServiceOptions = {},
  ) {
    this.contentOperatorPort = options.contentOperatorPort;
    this.clock = options.clock ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.operatorLabel = operatorLabelSchema.parse(
      options.operatorLabel ?? defaultOperatorLabel,
    );
    this.analysisPort =
      options.analysisPort ?? new DisabledCommentAnalysisPort();
  }

  async readPublicationPolicy(): Promise<PublicationPolicyState> {
    const state = await this.commentPort.readPublicationPolicy();
    return publicationPolicyStateSchema.parse({
      policy: state.policy,
      updatedAt: isoUtc(state.updatedAt),
      updatedBy: state.updatedBy,
    });
  }

  /**
   * Switching affects new submissions only: no existing row is rewritten, and
   * no bulk publication or takedown is part of the setting.
   */
  async setPublicationPolicy(body: unknown): Promise<PublicationPolicyState> {
    const command = this.parse(setPublicationPolicyCommandSchema, body);
    // Choosing the mode already in force changes nothing and records nothing.
    const current = await this.readPublicationPolicy();
    if (current.policy === command.policy) return current;
    const at = this.clock();
    // The switch and its audit row commit in one transaction at the port.
    await this.commentPort.writePublicationPolicy(
      command.policy,
      this.operatorLabel,
      at,
      this.draft("set_publication_policy", at, { detail: command.policy }),
    );
    return this.readPublicationPolicy();
  }

  /** The review queue: bounded filters and search, status counts, review order. */
  async readComments(query: unknown): Promise<OperatorCommentPage> {
    const parsed = this.parse(operatorCommentQuerySchema, query);
    const listing = await this.commentPort.readOperatorComments({
      ...(parsed.moderation === undefined
        ? {}
        : { moderation: parsed.moderation }),
      ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
      ...(parsed.catalogId === undefined
        ? {}
        : { catalogId: parsed.catalogId }),
      ...(parsed.search === undefined ? {} : { search: parsed.search }),
      order: parsed.order ?? "newest",
      page: parsed.page ?? 1,
      pageSize: parsed.pageSize ?? defaultOperatorPageSize,
    });
    const items = await this.withTitles(listing.items);
    return operatorCommentPageSchema.parse({
      items,
      counts: listing.counts,
      total: listing.total,
      page: listing.page,
      pageSize: listing.pageSize,
      totalPages:
        listing.total === 0 ? 0 : Math.ceil(listing.total / listing.pageSize),
    });
  }

  /**
   * Full text, thread context, the stored state with any parent restriction,
   * the item's own audit history and the advisory analysis state.
   */
  async readCommentDetail(
    id: CatalogCommentId,
  ): Promise<OperatorCommentDetail> {
    const item = await this.commentPort.findOperatorComment(id);
    if (item === null)
      throw new CommunityNotFoundError("Comment was not found");
    const root =
      item.kind === "reply" && item.rootCommentId !== undefined
        ? await this.commentPort.findOperatorComment(item.rootCommentId)
        : null;
    const replyTo =
      item.replyToId === undefined
        ? null
        : await this.commentPort.findOperatorComment(item.replyToId);
    const history = await this.commentPort.readModerationEvents({
      subjectId: id,
      page: 1,
      pageSize: detailHistoryLimit,
    });
    const [itemWithTitle, rootWithTitle, replyToWithTitle] =
      await this.withTitles([item, root, replyTo]);
    const parentRestriction: ParentRestriction =
      root === null
        ? "none"
        : root.moderation === "pending"
          ? "root_pending"
          : root.moderation === "hidden"
            ? "root_hidden"
            : "none";
    return operatorCommentDetailSchema.parse({
      item: itemWithTitle,
      root: rootWithTitle ?? null,
      replyTo: replyToWithTitle ?? null,
      parentRestriction,
      history: history.items.map(toEventDto),
      analysis: await this.analysisPort.readLatest({
        id: item.id,
        kind: item.kind,
        text: item.text,
      }),
    });
  }

  /**
   * The authoritative result this exact command already committed, or null.
   * Read-only, so a caller deciding whether a target was applied can ask
   * without acting: a cancelled chunk must not mutate to find out.
   */
  async findAppliedComment(
    receipt: CommandReceipt,
  ): Promise<ModeratedSubject | null> {
    return this.commentPort.findCommandReceipt(this.operatorLabel, receipt);
  }

  /**
   * One transition. A subject in a state the edge cannot leave is a conflict
   * (409): nothing changes and nothing is recorded, so a stale queue can never
   * produce a misleading audit entry.
   */
  async moderateComment(
    id: CatalogCommentId,
    body: unknown,
    /**
     * Optional execution receipt (Issue #141 r4). When present the store
     * writes it in the same transaction as the transition and its audit row,
     * so a repeated identical command returns its original result instead of
     * mutating again, and the same identity carrying a different command is a
     * conflict. Ordinary Owner moderation passes none.
     */
    receipt?: CommandReceipt,
  ): Promise<ModerationResult> {
    const { action, reason } = this.parse(moderateCommentCommandSchema, body);
    const at = this.clock();
    const transition = moderationTransitions[action];
    // The audit row is written in the same transaction as the transition, so
    // a moderated row without its record (or the reverse) cannot exist.
    const moderated = await this.commentPort.applyCommentModeration(
      id,
      transition.to,
      transition.from,
      this.operatorLabel,
      at,
      this.draft(action, at, { ...(reason === undefined ? {} : { reason }) }),
      receipt,
    );
    if (moderated === null) {
      const current = await this.commentPort.findOperatorComment(id);
      if (current === null)
        throw new CommunityNotFoundError("Comment was not found");
      throw new CommunityConflictError(
        `Comment is ${current.moderation}; ${action} requires ${transition.from.join(" or ")}`,
      );
    }
    return { id: moderated.id, moderation: moderated.moderation };
  }

  /**
   * Selected items only, at most BULK_MODERATION_MAXIMUM, applied one after
   * another through the very same transition and audit path as a single
   * action. Each item reports applied, conflict, not_found or failed; a
   * repeated request finds the applied items in their new state and reports
   * conflicts, never a second effective transition or audit entry.
   */
  async moderateComments(body: unknown): Promise<BulkModerationResult> {
    const { action, ids, reason } = this.parse(
      bulkModerateCommentsCommandSchema,
      body,
    );
    const results: BulkModerationResult["results"] = [];
    const tally = { applied: 0, conflicts: 0, notFound: 0, failed: 0 };
    for (const id of ids) {
      try {
        const result = await this.moderateComment(id, {
          action,
          ...(reason === undefined ? {} : { reason }),
        });
        results.push({
          id,
          outcome: "applied",
          moderation: result.moderation,
        });
        tally.applied += 1;
      } catch (error) {
        if (isCommunityConflictError(error)) {
          results.push({ id, outcome: "conflict" });
          tally.conflicts += 1;
        } else if (isCommunityNotFoundError(error)) {
          results.push({ id, outcome: "not_found" });
          tally.notFound += 1;
        } else if (isCommunityStoreUnavailableError(error)) {
          // The store is down: the rest of the selection cannot be attempted.
          for (const remaining of ids.slice(results.length)) {
            results.push({ id: remaining, outcome: "failed" });
            tally.failed += 1;
          }
          break;
        } else {
          results.push({ id, outcome: "failed" });
          tally.failed += 1;
        }
      }
    }
    return { action, results, ...tally };
  }

  /**
   * Suspension revokes sessions and refuses new writes; comments keep their
   * state. The audit row commits with the status change, and only when the
   * status actually changed, so a retried command never records twice. A
   * deleted account (account-deletion-v1) is terminal: the port changes
   * nothing for it and the command is refused as a conflict.
   */
  async moderateUser(
    id: PublicUserId,
    body: unknown,
  ): Promise<UserModerationResult> {
    const { action, reason } = this.parse(moderateUserCommandSchema, body);
    const at = this.clock();
    const result = await this.identityPort.setUserStatus(
      id,
      action === "suspend" ? "suspended" : "active",
      at,
      this.draft(action, at, { ...(reason === undefined ? {} : { reason }) }),
    );
    if (result === null) throw new CommunityNotFoundError("User was not found");
    if (result.user.status === "deleted")
      throw new CommunityConflictError(
        "A deleted account cannot be suspended or reinstated",
      );
    return {
      id: result.user.id,
      status: result.user.status,
      revokedSessions: result.revokedSessions,
    };
  }

  /** The operation history, newest first, from the authoritative audit table. */
  async readModerationEvents(query: unknown): Promise<ModerationEventPage> {
    const parsed = this.parse(moderationEventQuerySchema, query);
    const page = await this.commentPort.readModerationEvents({
      ...(parsed.subjectId === undefined
        ? {}
        : { subjectId: parsed.subjectId }),
      ...(parsed.action === undefined ? {} : { action: parsed.action }),
      page: parsed.page ?? 1,
      pageSize: parsed.pageSize ?? defaultOperatorPageSize,
    });
    return moderationEventPageSchema.parse({
      items: page.items.map(toEventDto),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      totalPages: page.total === 0 ? 0 : Math.ceil(page.total / page.pageSize),
    });
  }

  /**
   * Small explicit numbers with their time range and refresh moment: the
   * queue as it stands, the actions recorded inside the range, the last few
   * events, and whether any analysis provider is connected at all.
   */
  async readSummary(query: unknown): Promise<ModerationSummary> {
    const parsed = this.parse(moderationSummaryQuerySchema, query);
    const key = parsed.range ?? "7d";
    const to = this.clock();
    const from = new Date(to.getTime() - summaryRangeMs[key]);
    const record = await this.commentPort.readModerationSummary({ from, to });
    const policy = await this.readPublicationPolicy();
    return moderationSummarySchema.parse({
      generatedAt: isoUtc(to),
      range: { key, from: isoUtc(from), to: isoUtc(to) },
      policy,
      queue: record.queue,
      actions: record.actions,
      recentEvents: record.recentEvents.map(toEventDto),
      analysis: { connected: this.analysisPort.connected },
    });
  }

  private parse<Schema extends { parse: (input: unknown) => unknown }>(
    schema: Schema,
    input: unknown,
  ): ReturnType<Schema["parse"]> {
    try {
      return schema.parse(input) as ReturnType<Schema["parse"]>;
    } catch {
      throw new CommunityInputError("Operator command is invalid");
    }
  }

  /** Titles come from the published Catalog read side, one lookup per record. */
  private async withTitles<Item extends OperatorCommentRecord | null>(
    items: readonly Item[],
  ): Promise<(Item extends null ? null : OperatorComment)[]> {
    const titles = new Map<CatalogId, string | null>();
    for (const item of items) {
      if (
        item !== null &&
        item.catalogId !== null &&
        !titles.has(item.catalogId)
      )
        titles.set(
          item.catalogId,
          await this.catalogPort.readTitle(item.catalogId),
        );
    }
    return (await Promise.all(
      items.map(async (item) =>
        item === null
          ? null
          : {
              ...item,
              catalogTitle:
                item.catalogId === null
                  ? null
                  : (titles.get(item.catalogId) ?? null),
              ...(item.target?.type === "work"
                ? {
                    contentTitle:
                      (await this.contentOperatorPort?.readWorkTitle(
                        item.target.id,
                      )) ?? null,
                  }
                : {}),
            },
      ),
    )) as (Item extends null ? null : OperatorComment)[];
  }

  /** The audit row a port writes beside a transition; the port fills the subject. */
  private draft(
    action: ModerationEventAction,
    occurredAt: Date,
    options: { readonly detail?: string; readonly reason?: string } = {},
  ): ModerationEventDraft {
    return {
      id: generateOpaqueId("moderation", this.randomBytes),
      occurredAt,
      operatorLabel: this.operatorLabel,
      action,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    };
  }
}
