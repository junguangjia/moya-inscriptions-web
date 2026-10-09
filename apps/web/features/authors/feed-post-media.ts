import type { ContentCard } from "@moya/contracts";
import {
  localCatalogMediaSrc,
  localCatalogRenditions,
} from "../detail/local-catalog-media";
import type { DetailMediaPresentation } from "../detail/catalog-detail-presentation";

/**
 * The images a single-column post shows, in the item's own order: the card's
 * gallery (each image in its full framing), else its one card image. Catalog
 * images take the local delivery form exactly as the card image does. A
 * gallery entry's Live flag only badges the card; motion never plays here.
 */
export const feedPostMedia = (
  item: ContentCard,
  label: string,
): DetailMediaPresentation[] => {
  const images = item.gallery ?? (item.media === null ? [] : [item.media]);
  return images.map((image) => ({
    id: image.id,
    alt: label,
    width: image.width,
    height: image.height,
    ...(item.target.type === "catalog"
      ? {
          src: localCatalogMediaSrc(image.src, item.target.id, image.id),
          renditions: localCatalogRenditions(image.renditions),
        }
      : { src: image.src, renditions: image.renditions }),
    placeholderColor: image.placeholderColor,
  }));
};
