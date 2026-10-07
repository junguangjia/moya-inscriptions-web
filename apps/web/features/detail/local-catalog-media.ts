/** Native synthetic Payload file URLs need the Web origin on a phone or tablet. */
export const localCatalogFileUrl = (src: string): URL | null => {
  try {
    const url = new URL(src);
    return url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/api\/media\/file\/[a-f0-9]{64}-[a-f0-9]{64}\.(png|jpg|webp)$/u.test(
        url.pathname,
      )
      ? url
      : null;
  } catch {
    return null;
  }
};

/**
 * unified-media-pipeline-v1: the Development resolver delivers a Catalog
 * rendition from the Backend's loopback port, which a phone on the LAN
 * acceptance origin cannot reach. Only this exact shape (no query, fragment
 * or credentials) names a rendition the Web origin relays.
 */
const developmentCatalogRendition =
  /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}\/v1\/development\/catalog-renditions\/(media-rendition-[0-9a-f]{32})$/u;

/**
 * In Development, a Catalog rendition URL becomes the same-origin relay path;
 * every other source, and every source outside Development, is unchanged.
 */
export const localCatalogRenditionSrc = (src: string): string => {
  if (process.env.NODE_ENV !== "development") return src;
  const id = developmentCatalogRendition.exec(src)?.[1];
  return id === undefined ? src : `/api/development/catalog-renditions/${id}`;
};

/** The same rewrite for every candidate of a Catalog rendition list. */
export const localCatalogRenditions = <Entry extends { readonly src: string }>(
  renditions: readonly Entry[] | undefined,
): readonly Entry[] | undefined =>
  renditions?.map((entry) => ({
    ...entry,
    src: localCatalogRenditionSrc(entry.src),
  }));

export const localCatalogMediaSrc = (
  src: string,
  catalogId: string,
  mediaId: string,
): string =>
  localCatalogFileUrl(src)
    ? `/api/catalog/${encodeURIComponent(catalogId)}/media/${encodeURIComponent(mediaId)}`
    : localCatalogRenditionSrc(src);
