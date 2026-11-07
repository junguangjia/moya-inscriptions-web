import { isCatalogQueryUnavailableError } from "../../../catalog/application/errors/catalog-query-unavailable-error.js";
import { CommunityNotFoundError } from "../errors/community-request-errors.js";
import { isCommunityStoreUnavailableError } from "../errors/community-store-unavailable-error.js";
import {
  catalogMediaDelivery,
  catalogMediaRenditionKeys,
} from "../../../catalog/application/mappers/catalog-public-contract-mapper.js";
import type { CatalogRenditionUrls } from "../../../catalog/application/mappers/catalog-public-contract-mapper.js";
import type { AuthorCommunityPort } from "../ports/author-community-port.js";
import type { CatalogPublicationPort } from "../ports/catalog-publication-port.js";
import type {
  DiscussionPort,
  DiscussionQuery,
} from "../ports/discussion-port.js";
import type {
  CommunityDiscoveryPort,
  DiscoveryCardMediaRecord,
  DiscoveryCardRecord,
} from "../ports/community-discovery-port.js";
import type { StorageUrlResolver } from "../../../catalog/application/ports/storage-url-resolver.js";
import type { EditorialContentReadService } from "../../../editorial/application/services/editorial-content-read-service.js";
import type { ThreadService } from "./thread-service.js";
import type { TimelinePostsPort } from "../ports/timeline-posts-port.js";
import type { DirectMessageService } from "./direct-message-service.js";
import type {
  AuthorListQuery,
  ContentCard,
  DiscoveryQuery,
  CatalogId,
  ContentIdentity,
  ContentRelationUpdate,
  ContentTimelineEntry,
  DiscussionTarget,
  Timeline,
  TimelinePostCounts,
} from "@moya/contracts";
import { mapTimeline } from "../mappers/timeline-contract-mapper.js";
import {
  mapContentTimelineEntry,
  mapTimelinePostCounts,
} from "../mappers/timeline-posts-contract-mapper.js";

const noRenditionUrls: CatalogRenditionUrls = new Map();

/** Public application boundary; the adapter enforces transactional ownership. */
const TIMELINE_OUTAGE_FAILED_RECORDS = 3;
const TIMELINE_ISOLATION_READS = 32;

const isCardAvailabilityFailure = (error: unknown) =>
  isCatalogQueryUnavailableError(error) ||
  isCommunityStoreUnavailableError(error);

export class AuthorCommunityService {
  constructor(
    readonly port: AuthorCommunityPort,
    private readonly catalog: CatalogPublicationPort,
    readonly discussion?: DiscussionPort,
    readonly discovery?: CommunityDiscoveryPort,
    private readonly mediaResolver?: StorageUrlResolver,
    /** content-community-completion-v1: published editorial reads, Development only. */
    readonly editorial?: EditorialContentReadService,
    /** content-community-completion-v1: Threads over Works, Development only. */
    readonly threads?: ThreadService,
    /** content-community-completion-v1: direct messages, Development only. */
    readonly messages?: DirectMessageService,
    /** timeline-posts-v1: posts attached to timeline rows. */
    readonly timelinePostsPort?: TimelinePostsPort,
  ) {}
  private async cards(
    items: readonly DiscoveryCardRecord[],
  ): Promise<ContentCard[]> {
    // Every Catalog image of the page (card images and gallery entries)
    // resolves in one batch; a representative image listed in its own
    // gallery resolves once.
    const catalogMedia = items.flatMap((item) =>
      [item.media, ...(item.gallery ?? [])].flatMap((media) =>
        media?.type === "catalog" ? [media] : [],
      ),
    );
    const locators = [
      ...new Map(
        catalogMedia.map((media) => [
          media.id,
          { mediaId: media.id, objectKey: media.objectKey },
        ]),
      ).values(),
    ];
    const facts = await this.mediaResolver?.catalogFacts?.(locators);
    const effective = catalogMedia.map((media) => ({
      ...media,
      ...facts?.get(JSON.stringify([media.id, media.objectKey])),
    }));
    // Catalog cards are a card context: candidates up to the anchor.
    const renditionKeys = [
      ...new Set(
        effective.flatMap((media) => catalogMediaRenditionKeys(media, "card")),
      ),
    ];
    if (locators.length && !this.mediaResolver)
      throw new CommunityNotFoundError("Media unavailable");
    const [urls, renditionUrls] = await Promise.all([
      this.mediaResolver?.resolveMany(
        locators.filter(({ objectKey }) => !objectKey.startsWith("editorial/")),
      ),
      renditionKeys.length === 0 ||
      this.mediaResolver?.resolveKeys === undefined
        ? noRenditionUrls
        : this.mediaResolver.resolveKeys(renditionKeys),
    ]);
    // Work images carry the path, candidates and feed framing the adapter
    // resolved for the viewer's revision; Catalog images their approved URL
    // and candidates, never framing.
    const cardImage = (
      m: DiscoveryCardMediaRecord,
    ): NonNullable<ContentCard["media"]> | null => {
      if (m.type === "work")
        return {
          id: m.id,
          width: m.width,
          height: m.height,
          src: m.src,
          ...(m.renditions === undefined
            ? {}
            : { renditions: [...m.renditions] }),
          ...(m.placeholderColor === undefined
            ? {}
            : { placeholderColor: m.placeholderColor }),
          ...(m.feed === undefined ? {} : { feed: m.feed }),
        };
      const image = {
        ...m,
        ...facts?.get(JSON.stringify([m.id, m.objectKey])),
      };
      const entries = catalogMediaRenditionKeys(image, "card");
      const anchor = image.renditions?.find(
        (entry) => entry.level === "display",
      );
      const editorial = image.objectKey.startsWith("editorial/");
      if (
        editorial &&
        (!anchor ||
          !entries.length ||
          entries.some((key) => !renditionUrls.has(key)))
      )
        return null;
      const src = editorial ? renditionUrls.get(anchor!.key) : urls?.get(m.id);
      if (!src) return null;
      const delivery = catalogMediaDelivery(image, src, renditionUrls, "card");
      return {
        id: m.id,
        width: delivery.width,
        height: delivery.height,
        src: delivery.src,
        ...(delivery.renditions === undefined
          ? {}
          : { renditions: delivery.renditions }),
        ...(delivery.placeholderColor === undefined
          ? {}
          : { placeholderColor: delivery.placeholderColor }),
      };
    };
    return items.map((item): ContentCard => {
      const { gallery: galleryRecords, mediaCount, ...card } = item;
      const m = item.media;
      if (!m) return { ...card, media: null };
      const media = cardImage(m);
      if (media === null) {
        if (m.type === "catalog" && m.objectKey.startsWith("editorial/"))
          return { ...card, media: null };
        throw new CommunityNotFoundError("Media unavailable");
      }
      // A gallery entry without an approved URL is left out (the card keeps
      // its total); a card left with no entry carries no gallery.
      const gallery = (galleryRecords ?? []).flatMap((entry) => {
        const image = cardImage(entry);
        if (image === null) {
          console.warn("[catalog-media] gallery_fallback");
          return [];
        }
        return [{ ...image, ...(entry.live === true ? { live: true } : {}) }];
      });
      return {
        ...card,
        media,
        ...(gallery.length === 0 || mediaCount === undefined
          ? {}
          : { gallery, mediaCount }),
      };
    });
  }
  async browse(viewer: string | null, query: DiscoveryQuery) {
    if (!this.discovery) throw new CommunityNotFoundError();
    const page = await this.discovery.browse(viewer, query);
    return { ...page, items: await this.cards(page.items) };
  }
  async collection(
    owner: string,
    viewer: string | null,
    list: "favorite" | "like",
    query: AuthorListQuery,
  ) {
    if (!this.discovery) throw new CommunityNotFoundError();
    const page = await this.discovery.collection(owner, viewer, list, query);
    return { ...page, items: await this.cards(page.items) };
  }
  async card(target: ContentIdentity, viewer: string | null) {
    if (!this.discovery) throw new CommunityNotFoundError();
    const [item] = await this.cards([
      await this.discovery.card(target, viewer),
    ]);
    return item!;
  }
  /**
   * Linked rows take their image through the card path, so its delivery rules
   * hold here too; a row without an eligible link reaches none of it.
   */
  async timeline(): Promise<Timeline> {
    if (!this.discovery) throw new CommunityNotFoundError();
    const { entries, cards } = await this.discovery.timeline();
    return mapTimeline(entries, await this.timelineCards(cards));
  }
  /**
   * One record's unresolvable image leaves that row text-only instead of
   * failing every other row. An availability failure fails the read at once.
   */
  private async timelineCards(
    cards: readonly DiscoveryCardRecord[],
  ): Promise<ContentCard[]> {
    if (cards.length === 0) return [];
    try {
      return await this.cards(cards);
    } catch (batchError) {
      if (isCardAvailabilityFailure(batchError)) throw batchError;
      const resolved = await this.isolateCards(cards, batchError, {
        reads: 0,
        failedRecords: 0,
        imageResolved: false,
      });
      console.warn("[timeline] linked_image_fallback");
      return resolved;
    }
  }
  /**
   * Halves a failed batch, so one bad record costs a few reads, not one a row.
   * Several records failing with no image resolved is an outage that arrived as
   * a plain error, such as expired storage credentials, so it stops the walk.
   */
  private async isolateCards(
    cards: readonly DiscoveryCardRecord[],
    failure: unknown,
    walk: { reads: number; failedRecords: number; imageResolved: boolean },
  ): Promise<ContentCard[]> {
    if (cards.length === 1) {
      walk.failedRecords += 1;
      if (
        walk.failedRecords >= TIMELINE_OUTAGE_FAILED_RECORDS &&
        !walk.imageResolved
      )
        throw failure;
      return [];
    }
    const middle = cards.length >> 1;
    const resolved: ContentCard[] = [];
    const failed: { part: readonly DiscoveryCardRecord[]; error: unknown }[] =
      [];
    // Both halves first: a good half is cheap to keep, and it decides outage.
    for (const part of [cards.slice(0, middle), cards.slice(middle)]) {
      if (walk.reads >= TIMELINE_ISOLATION_READS) {
        // Past the budget the remaining rows stay text-only for this read.
        console.warn("[timeline] linked_image_budget");
        break;
      }
      walk.reads += 1;
      try {
        const read = await this.cards(part);
        walk.imageResolved ||= read.some(({ media }) => media !== null);
        resolved.push(...read);
      } catch (error) {
        if (isCardAvailabilityFailure(error)) throw error;
        failed.push({ part, error });
      }
    }
    for (const { part, error } of failed)
      resolved.push(...(await this.isolateCards(part, error, walk)));
    return resolved;
  }
  /**
   * timeline-posts-v1: a visible entry's posts for this viewer. Each post is
   * the viewer's Work read, so a page holds what the author's Works page
   * would show of it.
   */
  async timelineEntryPosts(
    entryId: string,
    viewer: string | null,
    query: AuthorListQuery,
  ) {
    if (!this.timelinePostsPort) throw new CommunityNotFoundError();
    return this.timelinePostsPort.listTimelinePosts(entryId, viewer, query);
  }
  /** timeline-posts-v1: the per-row counts of those same lists for this viewer. */
  async timelinePostCounts(viewer: string | null): Promise<TimelinePostCounts> {
    if (!this.timelinePostsPort) throw new CommunityNotFoundError();
    return mapTimelinePostCounts(
      await this.timelinePostsPort.timelinePostCounts(viewer),
    );
  }
  /**
   * timeline-posts-v1: the timeline row of a work or a Catalog record. A
   * target the viewer may not see is not found, as its card and state are.
   * A work follows the posts list's own rule (workVisibleTo): its author
   * reads the row of an own work that list shows them, one an operator hid
   * or removed included, so they can take it off; a third party only while
   * the work is public, as its card.
   */
  async contentTimelineEntry(
    target: ContentIdentity,
    viewer: string | null,
  ): Promise<ContentTimelineEntry> {
    if (!this.timelinePostsPort) throw new CommunityNotFoundError();
    if (target.type === "work") {
      const work = await this.port.readWork(target.id, viewer);
      if (!work.available && !work.canEdit) throw new CommunityNotFoundError();
    } else await this.assertTarget(target, viewer);
    return mapContentTimelineEntry(
      await this.timelinePostsPort.timelineEntryOf(target, viewer),
    );
  }
  /** The adapter computes every total in one snapshot with the lists' own rules. */
  async profile(id: string, viewer: string | null) {
    return this.port.readProfile(id, viewer);
  }
  async assertTarget(
    target: DiscussionTarget,
    viewer: string | null,
  ): Promise<void> {
    if (target.type === "catalog") {
      if (!(await this.catalog.isPublished(target.id as CatalogId)))
        throw new CommunityNotFoundError();
    } else if (target.type === "article") {
      // content-community-completion-v1: only the exact published revision is
      // discussable; a pending replacement or a withdrawal reads as absent.
      if (
        this.editorial === undefined ||
        !(await this.editorial.isArticlePublished(target.id))
      )
        throw new CommunityNotFoundError();
    } else {
      const work = await this.port.readWork(target.id, viewer);
      if (!work.available) throw new CommunityNotFoundError();
    }
  }
  async commentLike(
    actor: string,
    id: string,
    enabled: boolean,
    request: string,
  ) {
    if (!this.discussion) throw new CommunityNotFoundError();
    await this.assertTarget(await this.discussion.discussionTarget(id), actor);
    await this.discussion.setDiscussionLike(actor, id, enabled, request);
  }
  async ownComments(actor: string, query: DiscussionQuery) {
    if (!this.discussion) throw new CommunityNotFoundError();
    const page = await this.discussion.ownComments(actor, query);
    // Retained records keep their order; a Catalog target that is no longer
    // published reads as null, answered for the whole page with one lookup.
    const published = await this.publishedIds([
      ...new Set(
        page.items.flatMap((item) =>
          item.target?.type === "catalog" ? [item.target.id as CatalogId] : [],
        ),
      ),
    ]);
    const articleIds = [
      ...new Set(
        page.items.flatMap((item) =>
          item.target?.type === "article" ? [item.target.id] : [],
        ),
      ),
    ];
    const publishedArticles = new Set<string>();
    if (this.editorial !== undefined)
      await Promise.all(
        articleIds.map(async (id) => {
          if (await this.editorial!.isArticlePublished(id))
            publishedArticles.add(id);
        }),
      );
    const items = page.items.map((item) =>
      (item.target?.type === "catalog" &&
        !published.has(item.target.id as CatalogId)) ||
      (item.target?.type === "article" &&
        !publishedArticles.has(item.target.id))
        ? {
            ...item,
            target: null,
            ...(item.images === undefined ? {} : { images: [] }),
          }
        : item,
    );
    return { ...page, items };
  }
  private async publishedIds(
    ids: readonly CatalogId[],
  ): Promise<ReadonlySet<CatalogId>> {
    if (ids.length === 0) return new Set();
    if (this.catalog.publishedIds) return this.catalog.publishedIds(ids);
    const published = new Set<CatalogId>();
    await Promise.all(
      ids.map(async (id) => {
        if (await this.catalog.isPublished(id)) published.add(id);
      }),
    );
    return published;
  }
  async relation(
    actor: string,
    kind: "favorite" | "like",
    input: ContentRelationUpdate,
  ): Promise<void> {
    if (
      input.enabled &&
      input.target.type === "catalog" &&
      !(await this.catalog.isPublished(input.target.id as CatalogId))
    )
      throw new CommunityNotFoundError();
    await this.port.changeRelation(actor, kind, input);
  }
}
