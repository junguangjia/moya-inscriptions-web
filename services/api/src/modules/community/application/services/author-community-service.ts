import { CommunityNotFoundError } from "../errors/community-request-errors.js";
import type { AuthorCommunityPort } from "../ports/author-community-port.js";
import type { CatalogPublicationPort } from "../ports/catalog-publication-port.js";
import type {
  DiscussionPort,
  DiscussionQuery,
} from "../ports/discussion-port.js";
import type {
  CommunityDiscoveryPort,
  DiscoveryCardRecord,
} from "../ports/community-discovery-port.js";
import type { StorageUrlResolver } from "../../../catalog/application/ports/storage-url-resolver.js";
import type { EditorialContentReadService } from "../../../editorial/application/services/editorial-content-read-service.js";
import type { ThreadService } from "./thread-service.js";
import type { DirectMessageService } from "./direct-message-service.js";
import type {
  AuthorListQuery,
  ContentCard,
  DiscoveryQuery,
  CatalogId,
  ContentIdentity,
  ContentRelationUpdate,
  DiscussionTarget,
} from "@moya/contracts";

/** Public application boundary; the adapter enforces transactional ownership. */
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
  ) {}
  private async cards(
    items: readonly DiscoveryCardRecord[],
  ): Promise<ContentCard[]> {
    const locators = items.flatMap((item) =>
      item.media?.type === "catalog"
        ? [{ mediaId: item.media.id, objectKey: item.media.objectKey }]
        : [],
    );
    if (locators.length && !this.mediaResolver)
      throw new CommunityNotFoundError("Media unavailable");
    const urls = await this.mediaResolver?.resolveMany(locators);
    return items.map((item) => {
      const m = item.media;
      if (!m) return { ...item, media: null };
      // Work cards carry the path the adapter resolved for the viewer's revision.
      const src = m.type === "work" ? m.src : urls?.get(m.id);
      if (!src) throw new CommunityNotFoundError("Media unavailable");
      return {
        ...item,
        media: { id: m.id, width: m.width, height: m.height, src },
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
        ? { ...item, target: null }
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
