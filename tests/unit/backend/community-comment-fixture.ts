import {
  CommunityConflictError,
  CommunityStoreUnavailableError,
} from "@moya/api";

import { fixtureUsers } from "./community-identity-fixture.js";

import type {
  CommandReceipt,
  PublicationPolicyWrite,
  CatalogCommentReplyRecord,
  CatalogCommentRecord,
  CatalogCommentWithReplies,
  CatalogPublicationPort,
  CommentInsert,
  CommentListingRecord,
  CommentPageQuery,
  CommentPageRecord,
  CommunityCommentPort,
  ModeratedSubject,
  ModerationEvent,
  ModerationEventDraft,
  ModerationEventQueryInput,
  ModerationSummaryRecord,
  OperatorCommentListing,
  OperatorCommentQueryInput,
  OperatorCommentRecord,
  ReplyInsert,
  ReplyPageQuery,
} from "@moya/api";
import type { CatalogCommentId, CatalogId } from "@moya/contracts";
import type {
  CommentModerationState,
  ModerationEventAction,
  PublicationPolicy,
} from "@moya/contracts/internal/community-operator";

export const publishedCatalogId = "catalog-published-01" as CatalogId;

/** Only the published record answers true, mirroring the Catalog read side. */
export class FixtureCatalogPublicationPort implements CatalogPublicationPort {
  constructor(
    private readonly published: ReadonlySet<string> = new Set([
      publishedCatalogId,
    ]),
  ) {}

  /** Every `publishedIds` call, so a service test can assert one lookup per page. */
  readonly publishedIdsCalls: (readonly CatalogId[])[] = [];

  async isPublished(catalogId: CatalogId): Promise<boolean> {
    return this.published.has(catalogId);
  }

  async publishedIds(
    ids: readonly CatalogId[],
  ): Promise<ReadonlySet<CatalogId>> {
    this.publishedIdsCalls.push(ids);
    return new Set(ids.filter((id) => this.published.has(id)));
  }

  /** The fixture's published titles; unknown records read as unpublished. */
  async readTitle(catalogId: CatalogId): Promise<string | null> {
    return this.published.has(catalogId) ? `资料 ${catalogId}` : null;
  }
}

const byNewest = (
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number =>
  right.createdAt.getTime() - left.createdAt.getTime() ||
  right.id.localeCompare(left.id);

const byOldest = (
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number =>
  left.createdAt.getTime() - right.createdAt.getTime() ||
  left.id.localeCompare(right.id);

/** Deterministic in-memory port mirroring the adapter's SQL semantics. */
export class InMemoryCommunityCommentPort implements CommunityCommentPort {
  readonly comments = new Map<string, CatalogCommentRecord>();
  readonly replies = new Map<
    string,
    CatalogCommentReplyRecord & { readonly replyToReplyId?: string }
  >();
  readonly events: ModerationEvent[] = [];
  /** DIRECT_PUBLICATION is the initial default since the 2026-09-12 scope amendment. */
  policy: PublicationPolicy = "DIRECT_PUBLICATION";
  policyUpdatedAt = new Date("2026-09-12T00:00:00.000Z");
  policyUpdatedBy = "platform";
  unavailable = false;
  /** The store goes down when this subject's moderation is attempted. */
  unavailableFrom: string | null = null;
  /** The next audited policy write fails at the audit insert, changing nothing. */
  failNextAudit = false;

  private assertAvailable(): void {
    if (this.unavailable) throw new CommunityStoreUnavailableError();
  }

  private visibleRepliesFor(rootId: string): CatalogCommentReplyRecord[] {
    return [...this.replies.values()]
      .filter(
        (reply) =>
          reply.rootCommentId === rootId && reply.moderation === "visible",
      )
      .sort(byOldest);
  }

  /** Mirrors the adapter's hot selection and exclusion, in one in-memory pass. */
  async readVisibleComments(
    query: CommentPageQuery,
  ): Promise<CommentListingRecord<CatalogCommentWithReplies>> {
    this.assertAvailable();
    const visible = [...this.comments.values()].filter(
      (comment) =>
        comment.catalogId === query.catalogId &&
        comment.moderation === "visible",
    );
    const heat = (id: string): number => this.visibleRepliesFor(id).length;
    const hot = visible
      .filter((comment) => heat(comment.id) > 0)
      .sort(
        (left, right) =>
          heat(right.id) - heat(left.id) || byNewest(left, right),
      )
      .slice(0, query.hotLimit);
    const excluded = new Set<string>([
      ...query.pinned,
      ...hot.map((comment) => comment.id),
    ]);
    const latest = visible
      .filter((comment) => !excluded.has(comment.id))
      .sort(byNewest);
    const attach = (
      comment: CatalogCommentRecord,
    ): CatalogCommentWithReplies => ({
      ...comment,
      replies: this.visibleRepliesFor(comment.id).slice(
        0,
        query.embeddedReplyLimit,
      ),
      replyTotal: heat(comment.id),
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      hot: hot.map(attach),
      items: latest.slice(start, start + query.pageSize).map(attach),
      total: latest.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async readVisibleReplies(
    query: ReplyPageQuery,
  ): Promise<CommentPageRecord<CatalogCommentReplyRecord>> {
    this.assertAvailable();
    const matching = this.visibleRepliesFor(query.rootCommentId);
    const start = (query.page - 1) * query.pageSize;
    return {
      items: matching.slice(start, start + query.pageSize),
      total: matching.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findComment(
    id: CatalogCommentId,
  ): Promise<CatalogCommentRecord | null> {
    this.assertAvailable();
    return this.comments.get(id) ?? null;
  }

  async findReply(
    id: CatalogCommentId,
  ): Promise<CatalogCommentReplyRecord | null> {
    this.assertAvailable();
    return this.replies.get(id) ?? null;
  }

  async insertComment(comment: CommentInsert): Promise<CatalogCommentRecord> {
    this.assertAvailable();
    const author = fixtureUsers.active;
    const record: CatalogCommentRecord = {
      id: comment.id,
      catalogId: comment.catalogId,
      author: { id: comment.authorId, displayName: author.displayName },
      text: comment.text,
      createdAt: comment.createdAt,
      moderation: comment.moderation,
    };
    this.comments.set(record.id, record);
    return record;
  }

  async insertReply(reply: ReplyInsert): Promise<CatalogCommentReplyRecord> {
    this.assertAvailable();
    const target =
      reply.replyToReplyId === undefined
        ? undefined
        : this.replies.get(reply.replyToReplyId);
    const record: CatalogCommentReplyRecord & { replyToReplyId?: string } = {
      id: reply.id,
      rootCommentId: reply.rootCommentId,
      author: {
        id: reply.authorId,
        displayName: fixtureUsers.active.displayName,
      },
      text: reply.text,
      createdAt: reply.createdAt,
      moderation: reply.moderation,
      ...(target === undefined ? {} : { replyTo: target.author }),
      ...(reply.replyToReplyId === undefined
        ? {}
        : { replyToReplyId: reply.replyToReplyId }),
    };
    this.replies.set(record.id, record);
    return record;
  }

  /** Ids whose next moderation write throws, to exercise the failed outcome. */
  failNextModeration = new Set<string>();

  /** Execution receipts, keyed exactly as the store keys them. */
  private readonly receipts = new Map<
    string,
    { readonly fingerprint: string; readonly result: ModeratedSubject }
  >();

  /** Mirrors the adapter: the exact command's own result, or nothing. */
  async findCommandReceipt(
    operatorLabel: string,
    receipt: CommandReceipt,
  ): Promise<ModeratedSubject | null> {
    const stored = this.receipts.get(
      `${operatorLabel}\u0000${receipt.requestId}`,
    );
    return stored === undefined || stored.fingerprint !== receipt.fingerprint
      ? null
      : stored.result;
  }

  /**
   * Mirrors the adapter: a row outside `from` matches nothing, and a command
   * that carries a receipt replays its own stored result instead of acting
   * twice, while the same identity carrying another command conflicts.
   */
  async applyCommentModeration(
    id: CatalogCommentId,
    moderation: CommentModerationState,
    from: readonly CommentModerationState[],
    operatorLabel?: string,
    _at?: Date,
    audit?: ModerationEventDraft,
    receipt?: CommandReceipt,
  ): Promise<ModeratedSubject | null> {
    this.assertAvailable();
    if (this.unavailableFrom === id) throw new CommunityStoreUnavailableError();
    if (this.failNextModeration.delete(id))
      throw new Error("Simulated moderation write failure");
    const key =
      receipt === undefined
        ? null
        : `${operatorLabel ?? ""}\u0000${receipt.requestId}`;
    if (key !== null && receipt !== undefined) {
      const stored = this.receipts.get(key);
      if (stored !== undefined) {
        if (stored.fingerprint !== receipt.fingerprint)
          throw new CommunityConflictError(
            "Reused command identity with other content",
          );
        return stored.result;
      }
    }
    const record = (subject: ModeratedSubject): ModeratedSubject => {
      if (audit !== undefined)
        this.events.push({
          ...audit,
          subjectKind: subject.kind,
          subjectId: subject.id,
        });
      return subject;
    };
    const keep = (subject: ModeratedSubject): ModeratedSubject => {
      if (key !== null && receipt !== undefined)
        this.receipts.set(key, {
          fingerprint: receipt.fingerprint,
          result: subject,
        });
      return subject;
    };
    const comment = this.comments.get(id);
    if (comment !== undefined && from.includes(comment.moderation)) {
      this.comments.set(id, { ...comment, moderation });
      return keep(record({ id, kind: "comment", moderation }));
    }
    const reply = this.replies.get(id);
    if (reply !== undefined && from.includes(reply.moderation)) {
      this.replies.set(id, { ...reply, moderation });
      return keep(record({ id, kind: "reply", moderation }));
    }
    return null;
  }

  /** The suspension state each fixture author currently has. */
  readonly userStatus = new Map<string, "active" | "suspended">();

  private operatorRows(): (OperatorCommentRecord & {
    readonly raw: { createdAt: Date; id: string };
  })[] {
    const status = (id: string) => this.userStatus.get(id) ?? "active";
    const handle = (id: string) =>
      Object.values(fixtureUsers).find((user) => user.id === id)?.handle ??
      fixtureUsers.active.handle;
    return [
      ...[...this.comments.values()].map((comment) => ({
        id: comment.id,
        kind: "comment" as const,
        catalogId: comment.catalogId,
        author: {
          id: comment.author.id,
          handle: handle(comment.author.id),
          displayName: comment.author.displayName,
          status: status(comment.author.id),
        },
        text: comment.text,
        createdAt: comment.createdAt
          .toISOString()
          .replace(/\.\d{3}Z$/, ".000Z"),
        moderation: comment.moderation,
        raw: comment,
      })),
      ...[...this.replies.values()].map((reply) => ({
        id: reply.id,
        kind: "reply" as const,
        catalogId:
          this.comments.get(reply.rootCommentId)?.catalogId ??
          publishedCatalogId,
        rootCommentId: reply.rootCommentId,
        ...(reply.replyToReplyId === undefined
          ? {}
          : { replyToId: reply.replyToReplyId as CatalogCommentId }),
        author: {
          id: reply.author.id,
          handle: handle(reply.author.id),
          displayName: reply.author.displayName,
          status: status(reply.author.id),
        },
        text: reply.text,
        createdAt: reply.createdAt.toISOString().replace(/\.\d{3}Z$/, ".000Z"),
        moderation: reply.moderation,
        raw: reply,
      })),
    ];
  }

  /** Mirrors the adapter: substring search, bounded filters, counts per state. */
  async readOperatorComments(
    query: OperatorCommentQueryInput,
  ): Promise<OperatorCommentListing> {
    this.assertAvailable();
    const needle = query.search?.toLowerCase();
    const filtered = this.operatorRows().filter(
      (row) =>
        (query.kind === undefined || row.kind === query.kind) &&
        (query.catalogId === undefined || row.catalogId === query.catalogId) &&
        (needle === undefined ||
          row.text.toLowerCase().includes(needle) ||
          row.author.handle.toLowerCase().includes(needle) ||
          row.author.displayName.toLowerCase().includes(needle)),
    );
    const counts = { pending: 0, visible: 0, hidden: 0 };
    for (const row of filtered) counts[row.moderation] += 1;
    const rows = filtered
      .filter(
        (row) =>
          query.moderation === undefined || row.moderation === query.moderation,
      )
      .sort((left, right) =>
        query.order === "oldest"
          ? byOldest(left.raw, right.raw)
          : byNewest(left.raw, right.raw),
      )
      .map((row) => {
        const { raw, ...operatorRow } = row;
        void raw;
        return operatorRow;
      });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: rows.slice(start, start + query.pageSize),
      counts: { ...counts, all: filtered.length },
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOperatorComment(
    id: CatalogCommentId,
  ): Promise<OperatorCommentRecord | null> {
    this.assertAvailable();
    const row = this.operatorRows().find((candidate) => candidate.id === id);
    if (row === undefined) return null;
    const { raw, ...operatorRow } = row;
    void raw;
    return operatorRow;
  }

  async readModerationEvents(
    query: ModerationEventQueryInput,
  ): Promise<CommentPageRecord<ModerationEvent>> {
    this.assertAvailable();
    const matching = [...this.events]
      .filter(
        (event) =>
          (query.subjectId === undefined ||
            event.subjectId === query.subjectId) &&
          (query.action === undefined || event.action === query.action),
      )
      .sort(
        (left, right) =>
          right.occurredAt.getTime() - left.occurredAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: matching.slice(start, start + query.pageSize),
      total: matching.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async readModerationSummary(range: {
    readonly from: Date;
    readonly to: Date;
  }): Promise<ModerationSummaryRecord> {
    this.assertAvailable();
    const queue = { pending: 0, visible: 0, hidden: 0 };
    for (const row of this.operatorRows()) queue[row.moderation] += 1;
    const actions: Record<ModerationEventAction, number> = {
      delete_body: 0,
      remove_thread: 0,
      approve: 0,
      reject: 0,
      hide: 0,
      unhide: 0,
      suspend: 0,
      reinstate: 0,
      set_publication_policy: 0,
    };
    for (const event of this.events)
      if (event.occurredAt >= range.from && event.occurredAt < range.to)
        actions[event.action] += 1;
    return {
      queue: { ...queue, all: queue.pending + queue.visible + queue.hidden },
      actions,
      recentEvents: (await this.readModerationEvents({ page: 1, pageSize: 10 }))
        .items,
    };
  }

  async readPublicationPolicy(): Promise<{
    readonly policy: PublicationPolicy;
    readonly updatedAt: Date;
    readonly updatedBy: string;
  }> {
    this.assertAvailable();
    return {
      policy: this.policy,
      updatedAt: this.policyUpdatedAt,
      updatedBy: this.policyUpdatedBy,
    };
  }

  /** Mirrors the adapter: the switch and its audit row happen together, and only on a change. */
  async writePublicationPolicy(
    policy: PublicationPolicy,
    operatorLabel: string,
    at: Date,
    audit?: ModerationEventDraft,
    receipt?: CommandReceipt,
  ): Promise<PublicationPolicyWrite | null> {
    this.assertAvailable();
    const state = () => ({
      policy: this.policy,
      updatedAt: this.policyUpdatedAt,
      updatedBy: this.policyUpdatedBy,
    });
    if (this.policy === policy)
      return receipt === undefined ? null : { ...state(), unchanged: true };
    if (audit !== undefined) {
      if (this.failNextAudit) {
        this.failNextAudit = false;
        throw new Error("Simulated audit insert failure");
      }
      this.events.push({
        ...audit,
        subjectKind: "setting",
        subjectId: "publication",
      });
    }
    this.policy = policy;
    this.policyUpdatedBy = operatorLabel;
    this.policyUpdatedAt = at;
    return receipt === undefined ? null : state();
  }

  async recordModerationEvent(event: ModerationEvent): Promise<void> {
    this.assertAvailable();
    this.events.push(event);
  }
}
