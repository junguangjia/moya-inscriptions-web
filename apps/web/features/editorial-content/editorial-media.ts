import { localCatalogFileUrl } from "../detail/local-catalog-media";

/**
 * Development: editorial images (Article covers, section and academic figures,
 * Collection covers) are native synthetic Payload files at loopback URLs, which
 * a phone on the LAN acceptance origin cannot reach. Serve those through the
 * Web origin, named by the published Article or Collection that shows them;
 * every other source is returned unchanged.
 */
export const editorialMediaSrc = (src: string, owner: string): string => {
  const url = localCatalogFileUrl(src);
  return url
    ? `/api/editorial-media/${encodeURIComponent(owner)}/${url.pathname.slice("/api/media/file/".length)}`
    : src;
};
