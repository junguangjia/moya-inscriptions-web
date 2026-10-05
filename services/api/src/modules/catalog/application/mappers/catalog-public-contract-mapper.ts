import type {
  CatalogDetail,
  CatalogPage,
  CatalogSearchPage,
  CatalogSummary,
  MediaId,
  PublicMedia,
  PublicSourceCitation,
} from "@moya/contracts";
import {
  addMediaRenditionAnchorIssues,
  catalogDetailSchema,
  catalogPageSchema,
  catalogSearchPageSchema,
  catalogSummarySchema,
  placeholderColorSchema,
  publicMediaRenditionListSchema,
  publicMediaSchema,
  publicSourceCitationSchema,
} from "@moya/contracts/schemas";

import { CatalogMediaResolutionError } from "../errors/catalog-media-resolution-error.js";

import type {
  CatalogDetailProjection,
  CatalogListItemProjection,
  CatalogListPageProjection,
  CatalogMediaProjection,
  CatalogMediaRenditionLevel,
  CatalogMediaRenditionProjection,
  CatalogSourceCitationProjection,
  CatalogStatefulTextProjection,
} from "../catalog-read-projections.js";
import type { CatalogSearchPageProjection } from "../ports/catalog-search-query-port.js";
import type { ResolvedMediaUrl } from "../ports/storage-url-resolver.js";

const noResolvedMedia = new Map<MediaId, ResolvedMediaUrl>();

/**
 * The context of a Catalog image (unified media pipeline, CW4): card
 * contexts (lists, search, cards, summaries) stop at the anchor; detail
 * contexts add the zoom levels.
 */
export type CatalogMediaContext = "card" | "detail";

/** The Catalog image facts the public media mapping reads. */
export type CatalogImageProjection = Pick<
  CatalogMediaProjection,
  "id" | "alt" | "width" | "height" | "renditions" | "placeholderColor"
>;

/** Rendition delivery URLs by opaque delivery key, as `resolveKeys` answers. */
export type CatalogRenditionUrls = ReadonlyMap<string, ResolvedMediaUrl>;

const noRenditionUrls: CatalogRenditionUrls = new Map();

const contextLevels: Readonly<
  Record<CatalogMediaContext, readonly CatalogMediaRenditionLevel[]>
> = {
  card: ["card", "display"],
  detail: ["card", "display", "zoom"],
};

/**
 * The renditions of one image a context lists, ascending by size with one
 * entry per size (the display-level anchor wins a tie, else the first
 * listed); none unless exactly one display-level rendition is the anchor.
 */
const contextRenditions = (
  image: Pick<CatalogImageProjection, "renditions">,
  context: CatalogMediaContext,
): readonly CatalogMediaRenditionProjection[] => {
  const levels = contextLevels[context];
  const listed = (image.renditions ?? []).filter(({ level }) =>
    levels.includes(level),
  );
  const anchors = listed.filter(({ level }) => level === "display");
  if (anchors.length !== 1) return [];
  const bySize = new Map<string, CatalogMediaRenditionProjection>();
  for (const entry of listed) {
    const size = `${entry.width}x${entry.height}`;
    if (!bySize.has(size) || entry === anchors[0]) bySize.set(size, entry);
  }
  return [...bySize.values()].sort(
    (left, right) => left.width - right.width || left.height - right.height,
  );
};

/** The delivery keys one Catalog image needs in a context; none without an anchor. */
export const catalogMediaRenditionKeys = (
  image: Pick<CatalogImageProjection, "renditions">,
  context: CatalogMediaContext,
): string[] => contextRenditions(image, context).map(({ key }) => key);

/**
 * `src`, size, candidates and loading colour of one Catalog image in a
 * context (CW12): the anchor rendition with the context's candidates when
 * every one of them resolved and the list meets the contract, else the
 * approved image's resolved `src` without candidates. An empty resolution
 * means rendition delivery is off for this read; a partial one, or a list
 * the contract refuses, is logged (content-free). The colour describes the
 * approved image either way.
 */
export const catalogMediaDelivery = (
  image: Pick<
    CatalogImageProjection,
    "width" | "height" | "renditions" | "placeholderColor"
  >,
  src: ResolvedMediaUrl,
  renditionUrls: CatalogRenditionUrls,
  context: CatalogMediaContext,
): {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly renditions?: NonNullable<PublicMedia["renditions"]>;
  readonly placeholderColor?: string;
} => {
  const placeholder = placeholderColorSchema.safeParse(image.placeholderColor);
  const approved = {
    src,
    width: image.width,
    height: image.height,
    ...(placeholder.success ? { placeholderColor: placeholder.data } : {}),
  };
  const entries = contextRenditions(image, context);
  if (entries.length === 0 || renditionUrls.size === 0) return approved;
  const renditions: NonNullable<PublicMedia["renditions"]>[number][] = [];
  for (const entry of entries) {
    const url = renditionUrls.get(entry.key);
    if (url === undefined) {
      console.warn("[catalog-media] rendition_fallback");
      return approved;
    }
    renditions.push({
      src: url,
      width: entry.width,
      height: entry.height,
      contentType: entry.contentType,
    });
  }
  const anchor = entries.find(({ level }) => level === "display")!;
  const parent = {
    src: renditionUrls.get(anchor.key)!,
    width: anchor.width,
    height: anchor.height,
  };
  const list = publicMediaRenditionListSchema
    .superRefine((value, issues) =>
      addMediaRenditionAnchorIssues(parent, value, issues),
    )
    .safeParse(renditions);
  if (!list.success) {
    console.warn("[catalog-media] rendition_fallback");
    return approved;
  }
  return {
    ...parent,
    renditions: list.data,
    ...(placeholder.success ? { placeholderColor: placeholder.data } : {}),
  };
};

/**
 * One Catalog image as PublicMedia in a context. A missing approved `src`
 * or a response the contract refuses fails the read, as before renditions.
 */
export const mapCatalogPublicMedia = (
  image: CatalogImageProjection,
  resolvedMedia: ReadonlyMap<MediaId, ResolvedMediaUrl>,
  renditionUrls: CatalogRenditionUrls,
  context: CatalogMediaContext,
): PublicMedia => {
  const src = resolvedMedia.get(image.id);
  if (src === undefined) {
    throw new CatalogMediaResolutionError({
      cause: new Error(`Missing resolved URL for MediaId ${image.id}`),
    });
  }
  const delivery = catalogMediaDelivery(image, src, renditionUrls, context);
  const media = publicMediaSchema.safeParse({
    id: image.id,
    kind: "image",
    src: delivery.src,
    alt: image.alt,
    width: delivery.width,
    height: delivery.height,
    ...(delivery.renditions === undefined
      ? {}
      : { renditions: delivery.renditions }),
    ...(delivery.placeholderColor === undefined
      ? {}
      : { placeholderColor: delivery.placeholderColor }),
  });
  if (!media.success) {
    throw new CatalogMediaResolutionError({ cause: media.error });
  }
  return media.data;
};

const mapCatalogSourceCitation = (
  projection: CatalogSourceCitationProjection,
): PublicSourceCitation => {
  const citation: PublicSourceCitation = { label: projection.label };

  if (projection.citation !== undefined) {
    citation.citation = projection.citation;
  }
  if (projection.url !== undefined) {
    citation.url = projection.url;
  }
  if (projection.appliesTo !== undefined) {
    citation.appliesTo = [...projection.appliesTo];
  }

  return publicSourceCitationSchema.parse(citation);
};

const projectPublicText = (
  field?: CatalogStatefulTextProjection,
): string | undefined => (field?.state === "VALUE" ? field.value : undefined);

/**
 * A summary is a card context: its representative image lists candidates up
 * to the anchor. Without rendition URLs it keeps the approved image.
 */
export const mapCatalogSummary = (
  projection: CatalogListItemProjection,
  resolvedMedia: ReadonlyMap<MediaId, ResolvedMediaUrl> = noResolvedMedia,
  renditionUrls: CatalogRenditionUrls = noRenditionUrls,
): CatalogSummary => {
  const summary: CatalogSummary = {
    id: projection.id,
    kind: projection.kind,
    title: projection.title,
    aliases: [...projection.aliases],
  };

  if (projection.summary !== undefined) {
    summary.summary = projection.summary;
  }
  if (projection.periodLabel !== undefined) {
    summary.periodLabel = projection.periodLabel;
  }
  const province = projectPublicText(projection.province);
  if (province !== undefined) summary.province = province;
  if (projection.representativeMedia !== undefined) {
    summary.representativeMedia = mapCatalogPublicMedia(
      projection.representativeMedia,
      resolvedMedia,
      renditionUrls,
      "card",
    );
  }

  return catalogSummarySchema.parse(summary);
};

/**
 * Detail: the representative image in the card context, the gallery in the
 * detail context (with zoom levels).
 */
export const mapCatalogDetail = (
  projection: CatalogDetailProjection,
  resolvedMedia: ReadonlyMap<MediaId, ResolvedMediaUrl> = noResolvedMedia,
  renditionUrls: CatalogRenditionUrls = noRenditionUrls,
): CatalogDetail => {
  const detail: CatalogDetail = {
    ...mapCatalogSummary(projection, resolvedMedia, renditionUrls),
    sourceCitations: projection.sourceCitations.map(mapCatalogSourceCitation),
    media: projection.media.map((media) =>
      mapCatalogPublicMedia(media, resolvedMedia, renditionUrls, "detail"),
    ),
  };

  const dynasty = projectPublicText(projection.dynasty);
  if (dynasty !== undefined) {
    detail.dynasty = dynasty;
  }
  const dateText = projectPublicText(projection.dateText);
  if (dateText !== undefined) {
    detail.dateText = dateText;
  }
  const province = projectPublicText(projection.province);
  if (province !== undefined) {
    detail.province = province;
  }
  const prefecture = projectPublicText(projection.prefecture);
  if (prefecture !== undefined) {
    detail.prefecture = prefecture;
  }
  const county = projectPublicText(projection.county);
  if (county !== undefined) {
    detail.county = county;
  }
  const currentLocation = projectPublicText(projection.currentLocation);
  if (currentLocation !== undefined) {
    detail.currentLocation = currentLocation;
  }
  const currentCustodian = projectPublicText(projection.currentCustodian);
  if (currentCustodian !== undefined) {
    detail.currentCustodian = currentCustodian;
  }
  if (projection.description !== undefined) {
    detail.description = projection.description;
  }
  if (
    projection.contributors !== undefined &&
    projection.contributors.length > 0
  ) {
    detail.contributors = projection.contributors.map(({ name, role }) => ({
      name,
      role,
    }));
  }
  const scriptStyle = projectPublicText(projection.scriptStyle);
  if (scriptStyle !== undefined) {
    detail.scriptStyle = scriptStyle;
  }
  const transcription = projectPublicText(projection.transcription);
  if (transcription !== undefined) {
    detail.transcription = transcription;
  }
  const historicalContext = projectPublicText(projection.historicalContext);
  if (historicalContext !== undefined) {
    detail.historicalContext = historicalContext;
  }
  const scholarlyResearch = projectPublicText(projection.scholarlyResearch);
  if (scholarlyResearch !== undefined) {
    detail.scholarlyResearch = scholarlyResearch;
  }

  return catalogDetailSchema.parse(detail);
};

export const mapCatalogPage = (
  projection: CatalogListPageProjection,
  resolvedMedia: ReadonlyMap<MediaId, ResolvedMediaUrl> = noResolvedMedia,
  renditionUrls: CatalogRenditionUrls = noRenditionUrls,
): CatalogPage =>
  catalogPageSchema.parse({
    items: projection.items.map((item) =>
      mapCatalogSummary(item, resolvedMedia, renditionUrls),
    ),
    total: projection.total,
    page: projection.page,
    pageSize: projection.pageSize,
    totalPages: projection.totalPages,
  });

export const mapCatalogSearchPage = (
  projection: CatalogSearchPageProjection,
  resolvedMedia: ReadonlyMap<MediaId, ResolvedMediaUrl> = noResolvedMedia,
  renditionUrls: CatalogRenditionUrls = noRenditionUrls,
): CatalogSearchPage =>
  catalogSearchPageSchema.parse({
    items: projection.items.map((item) => ({
      ...mapCatalogSummary(item, resolvedMedia, renditionUrls),
      matchKind: item.matchKind,
    })),
    total: projection.total,
    page: projection.page,
    pageSize: projection.pageSize,
    totalPages: projection.totalPages,
  });
