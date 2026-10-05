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
export type DiscoveryCardRecord = Omit<ContentCard, "media"> & {
  readonly media:
    | (
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
             * The same-origin still path the card shows: the card derivative
             * (`/api/community/publishing/media/<itemId>/<variant>/<editKey>`,
             * the cover variant under the cover crop's edit key when it
             * exists) or, for an unedited legacy item, its Phase 4 user media
             * path (`/api/community/media/<user-media-id>`).
             */
            readonly src: string;
            readonly width: number;
            readonly height: number;
            /**
             * Card candidates of the cover still in its own framing, `src`
             * as the anchor; absent for a Phase 4 PNG and when the anchor
             * has no ready candidate.
             */
            readonly renditions?: readonly MediaRendition[];
            /** The cover item's loading colour; absent for a non-opaque image. */
            readonly placeholderColor?: string;
          }
      )
    | null;
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
