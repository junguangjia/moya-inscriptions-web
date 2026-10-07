import {
  localCatalogFileUrl,
  localCatalogRenditionSrc,
  localCatalogRenditions,
} from "../detail/local-catalog-media";
import { responsiveImage } from "../media/responsive-media";
import type {
  ResponsiveImage,
  ResponsiveMediaSource,
} from "../media/responsive-media";

/**
 * Development: editorial images (Article covers, section and academic figures,
 * Collection covers) are native synthetic Payload files at loopback URLs, which
 * a phone on the LAN acceptance origin cannot reach. Serve those through the
 * Web origin, named by the published Article or Collection that shows them; a
 * Catalog rendition (the anchor `src` of a cover with renditions) goes through
 * the Development rendition relay. Every other source is returned unchanged.
 */
export const editorialMediaSrc = (src: string, owner: string): string => {
  const url = localCatalogFileUrl(src);
  return url
    ? `/api/editorial-media/${encodeURIComponent(owner)}/${url.pathname.slice("/api/media/file/".length)}`
    : localCatalogRenditionSrc(src);
};

/**
 * The responsive image of a Catalog editorial picture: `src` and every
 * candidate pass the same Development rewrites, so the anchor still matches.
 */
export const editorialImage = (
  media: ResponsiveMediaSource,
  owner: string,
  sizes: string,
): ResponsiveImage =>
  responsiveImage(
    {
      src: editorialMediaSrc(media.src, owner),
      width: media.width,
      height: media.height,
      renditions: localCatalogRenditions(media.renditions),
    },
    sizes,
  );
