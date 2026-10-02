import { createHash } from "node:crypto";
import type { ArticleId, ArticleResolvedReferences } from "@moya/contracts";
import type {
  ArticleModerationResult,
  ArticlePendingCandidate,
  ArticlePendingListQuery,
  ArticlePendingMediaQuery,
  ArticlePendingPage,
  ArticlePendingPreview,
  ModerateArticlePendingCommand,
} from "@moya/contracts/internal/community-operator";
import {
  CommunityConflictError,
  CommunityNotFoundError,
  isCommunityNotFoundError,
} from "../../../community/application/errors/community-request-errors.js";
import { CommunityStoreUnavailableError } from "../../../community/application/errors/community-store-unavailable-error.js";
import type { AuthorCommunityPort } from "../../../community/application/ports/author-community-port.js";
import type { PublishingMediaByteRange } from "../../../community/application/ports/publishing-media-store-port.js";
import type {
  WorkPublishingService,
  PublishingMediaDelivery,
} from "../../../community/application/services/work-publishing-service.js";
import { openPublishingMemoryMedia } from "../../../community/application/services/publishing-memory-media.js";
import type { CatalogReadService } from "../../../catalog/application/services/catalog-read-service.js";
import {
  pendingArticleReferences,
  pendingArticleManagedMedia,
  parseArticlePendingPreview,
} from "../mappers/article-pending-preview-mapper.js";
import type { ArticlePublicationOperatorPort } from "../ports/article-publication-operator-port.js";

export interface ArticlePublicationOperatorServiceOptions {
  readonly operatorLabel?: string;
  readonly clock?: () => Date;
  readonly publishing?:
    Pick<WorkPublishingService, "readItem" | "openMedia"> | undefined;
  readonly catalog?: Pick<CatalogReadService, "getById"> | undefined;
  readonly authorMedia?: Pick<AuthorCommunityPort, "readMedia"> | undefined;
}
/** The transport validates the strict internal DTO; operator is server-fixed. */
export class ArticlePublicationOperatorService {
  private readonly operator: string;
  private readonly clock: () => Date;
  constructor(
    private readonly port: ArticlePublicationOperatorPort,
    private readonly options: ArticlePublicationOperatorServiceOptions = {},
  ) {
    this.operator = options.operatorLabel ?? "owner";
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(this.operator))
      throw new Error("Invalid configured operator label");
    this.clock = options.clock ?? (() => new Date());
  }
  listPending(query: ArticlePendingListQuery): Promise<ArticlePendingPage> {
    return this.port.listPending(query);
  }
  private assertCandidate(
    current: ArticlePendingCandidate,
    expected: Pick<
      ArticlePendingCandidate,
      "expectedVersion" | "candidateVersion" | "fingerprint"
    >,
  ): void {
    if (
      current.expectedVersion !== expected.expectedVersion ||
      current.candidateVersion !== expected.candidateVersion ||
      current.fingerprint !== expected.fingerprint
    )
      throw new CommunityConflictError(
        "The Article is no longer the pending exact candidate",
      );
  }
  private async managed(candidate: ArticlePendingCandidate, itemId: string) {
    if (this.options.publishing === undefined) return null;
    try {
      const item = await this.options.publishing.readItem(
        candidate.ownerId,
        itemId,
      );
      return item.id === itemId ? pendingArticleManagedMedia(item) : null;
    } catch (error) {
      if (isCommunityNotFoundError(error)) return null;
      throw error;
    }
  }
  async readPending(id: ArticleId): Promise<ArticlePendingPreview> {
    const candidate = await this.port.readPending(id);
    const resolved: ArticleResolvedReferences = Object.create(
      null,
    ) as ArticleResolvedReferences;
    const managed = new Map<
      string,
      ReturnType<ArticlePublicationOperatorService["managed"]>
    >();
    const catalogs = new Map<
      string,
      ReturnType<CatalogReadService["getById"]>
    >();
    for (const { refId, reference } of pendingArticleReferences(candidate)) {
      if (reference.type === "managed") {
        let value = managed.get(reference.itemId);
        if (value === undefined) {
          value = this.managed(candidate, reference.itemId);
          managed.set(reference.itemId, value);
        }
        const media = await value;
        resolved[refId] = media
          ? { type: "managed", media }
          : { type: "unavailable", reason: "media_unavailable" };
      } else {
        let value = catalogs.get(reference.catalogId);
        if (value === undefined) {
          value =
            this.options.catalog?.getById(reference.catalogId) ??
            Promise.resolve(null);
          catalogs.set(reference.catalogId, value);
        }
        const media = (await value)?.media.find(
          (item) => item.id === reference.mediaId,
        );
        resolved[refId] = media
          ? { type: "catalog", media }
          : { type: "unavailable", reason: "catalog_unavailable" };
      }
    }
    this.assertCandidate(await this.port.readPending(id), candidate);
    return parseArticlePendingPreview({
      ...candidate,
      resolvedReferences: resolved,
    });
  }
  /** Owner-only transport calls this with no client-supplied owner/item/URL. */
  async openPendingMedia(
    id: ArticleId,
    query: ArticlePendingMediaQuery,
    range?: PublishingMediaByteRange,
  ): Promise<PublishingMediaDelivery> {
    const candidate = await this.port.readPending(id);
    this.assertCandidate(candidate, query);
    const entry = pendingArticleReferences(candidate).find(
      (item) => item.refId === query.refId,
    );
    if (entry?.reference.type !== "managed") throw new CommunityNotFoundError();
    const publishing = this.options.publishing;
    if (publishing === undefined) throw new CommunityStoreUnavailableError();
    const media = await this.managed(candidate, entry.reference.itemId);
    if (media === null || (query.variant === "motion" && media.kind !== "live"))
      throw new CommunityNotFoundError();
    const legacy = /^\/api\/community\/media\/(user-media-[0-9a-f]{32})$/u.exec(
      media.src,
    );
    let delivery: PublishingMediaDelivery;
    if (legacy !== null) {
      if (query.variant !== "display" || this.options.authorMedia === undefined)
        throw new CommunityNotFoundError();
      const source = await this.options.authorMedia.readMedia(
        legacy[1]!,
        candidate.ownerId,
      );
      if (source === null) throw new CommunityNotFoundError();
      delivery = openPublishingMemoryMedia(
        source.bytes,
        createHash("sha256").update(source.bytes).digest("hex"),
        range,
      );
    } else {
      delivery = await publishing.openMedia(
        candidate.ownerId,
        entry.reference.itemId,
        query.variant,
        "base",
        range,
      );
    }
    try {
      this.assertCandidate(await this.port.readPending(id), candidate);
      return delivery;
    } catch (error) {
      if (delivery.read.status === "ok")
        await delivery.read.close().catch(() => undefined);
      throw error;
    }
  }
  moderatePending(
    id: ArticleId,
    command: ModerateArticlePendingCommand,
  ): Promise<ArticleModerationResult> {
    return this.port.moderatePending(this.operator, id, command, this.clock());
  }
}
