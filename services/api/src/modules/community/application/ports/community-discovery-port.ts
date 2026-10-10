import type {
  AuthorListQuery,
  ContentCard,
  ContentIdentity,
  ContentState,
  DiscoveryQuery,
  InscriptionFilterOptions,
  MediaId,
  MediaRendition,
} from "@moya/contracts";
import type { CatalogMediaRenditionProjection } from "../../../catalog/application/catalog-read-projections.js";
import type { AuthorPage } from "./author-community-port.js";
/** One image a discovery card shows, before the service resolves Catalog URLs. */
export type DiscoveryCardMediaRecord =
  | {
      readonly type: "catalog";
      readonly id: MediaId;
      readonly objectKey: string;
      readonly width: number;
      readonly height: number;
      /**
       * Ready renditions of the image's Catalog asset by delivery key;
       * the service resolves the card candidates.
       */
      readonly renditions?: readonly CatalogMediaRenditionProjection[];
      /** Loading colour of an opaque image whose Catalog asset is ready. */
      readonly placeholderColor?: string;
    }
  | {
      readonly type: "work";
      /** The media item id, or the user media id of an unedited legacy PNG. */
      readonly id: string;
      /**
       * The same-origin still path the card shows: a derivative
       * (`/api/community/publishing/media/<itemId>/<variant>/<editKey>`) or,
       * for an unedited legacy item, its Phase 4 user media path
       * (`/api/community/media/<user-media-id>`).
       */
      readonly src: string;
      readonly width: number;
      readonly height: number;
      /**
       * Card candidates of the still in its own framing, `src` as the
       * anchor; absent for a Phase 4 PNG and when the anchor has no ready
       * candidate.
       */
      readonly renditions?: readonly MediaRendition[];
      /** The item's loading colour; absent for a non-opaque image. */
      readonly placeholderColor?: string;
    };
export type DiscoveryCardRecord = Omit<ContentCard, "media" | "gallery"> & {
  /**
   * The card image: the Catalog representative image, or the work's cover
   * still (the cover derivative under the cover crop's edit key when it
   * exists).
   */
  readonly media: DiscoveryCardMediaRecord | null;
  /**
   * The item's first CARD_GALLERY_MAXIMUM shown images in their own order,
   * each in its full framing (a work's display still, with the Live flag);
   * present exactly when `media` is, with `mediaCount`.
   */
  readonly gallery?: readonly (DiscoveryCardMediaRecord & {
    readonly live?: boolean;
  })[];
};
export interface DiscoveryPageRecord {
  readonly items: readonly DiscoveryCardRecord[];
  readonly sequence: string;
  readonly nextAfter: number;
  readonly hasMore: boolean;
}
export interface CommunityDiscoveryPort {
  browse(
    viewer: string | null,
    query: DiscoveryQuery,
  ): Promise<DiscoveryPageRecord>;
  collection(
    owner: string,
    viewer: string | null,
    list: "favorite" | "like",
    query: AuthorListQuery,
  ): Promise<AuthorPage<DiscoveryCardRecord>>;
  card(
    target: ContentIdentity,
    viewer: string | null,
  ): Promise<DiscoveryCardRecord>;
  state(target: ContentIdentity, actor: string | null): Promise<ContentState>;
  filterOptions(): Promise<InscriptionFilterOptions>;
}
