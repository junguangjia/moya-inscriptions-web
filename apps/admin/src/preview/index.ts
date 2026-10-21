import {
  deriveCatalogPeriodLabel,
  mapCatalogDetail,
  type CatalogDetailProjection,
  type ResolvedMediaUrl,
} from "@moya/api";
import type { MediaId } from "@moya/contracts";
import {
  catalogDetailSchema,
  publicMediaSchema,
} from "@moya/contracts/schemas";
import { APIError, type Endpoint, type PayloadRequest } from "payload";

import { readDraft } from "../editorial/operations";
import { requireActor } from "../editorial/access";
import { EditorialError } from "../editorial/errors";
import { validateCatalogMedia } from "../media/validation";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie, Authorization",
  "X-Robots-Tag": "noindex, nofollow",
};
function configuredOrigin(name: "CMS_PUBLIC_URL" | "CMS_PREVIEW_WEB_URL"): URL {
  let url: URL;
  try {
    url = new URL(process.env[name] ?? "");
  } catch {
    throw new APIError("PREVIEW_CONFIGURATION_REQUIRED", 503);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        loopback &&
        process.env.CMS_ENVIRONMENT === "synthetic"
      ))
  )
    throw new APIError("PREVIEW_CONFIGURATION_INVALID", 503);
  return url;
}

/** The Admin link contains only the internal document id. Authentication remains a session cookie. */
export function adminPreviewURL(doc: Record<string, unknown>): string | null {
  if (!doc.id || !/^[1-9]\d*$/.test(String(doc.id))) return null;
  try {
    const web = configuredOrigin("CMS_PREVIEW_WEB_URL");
    const cms = configuredOrigin("CMS_PUBLIC_URL");
    // Payload's session cookie is host-only. A shared public hostname with
    // separate proxy routes (or synthetic ports) keeps that boundary intact.
    if (web.hostname !== cms.hostname) return null;
    return new URL(`/editorial-preview/${String(doc.id)}`, web).href;
  } catch {
    return null;
  }
}

export async function previewCatalogDetail(req: PayloadRequest, id: unknown) {
  requireActor(req);
  const { content } = await readDraft(req, { id });
  if (content.title === undefined)
    throw new APIError("PREVIEW_INCOMPLETE", 422);
  await validateCatalogMedia(req, content, { publishing: false });
  const resolved = new Map<MediaId, ResolvedMediaUrl>();
  if (content.media.length > 0) {
    const base = configuredOrigin("CMS_PUBLIC_URL");
    for (let offset = 0; offset < content.media.length; offset += 100) {
      const subset = content.media.slice(offset, offset + 100);
      const registered = await req.payload.find({
        collection: "media",
        where: {
          and: [
            { catalogId: { equals: content.catalogId } },
            { mediaId: { in: subset.map(({ mediaId }) => mediaId) } },
          ],
        },
        limit: 100,
        depth: 0,
        req,
        overrideAccess: false,
        select: { mediaId: true, filename: true },
      });
      for (const file of registered.docs) {
        if (!file.filename)
          throw new APIError("PREVIEW_MEDIA_UNAVAILABLE", 503);
        resolved.set(
          file.mediaId as MediaId,
          new URL(`/api/media/file/${encodeURIComponent(file.filename)}`, base)
            .href as ResolvedMediaUrl,
        );
      }
    }
  }
  // Authenticated draft originals use protected CMS URLs, not public delivery.
  const media = content.media.map((item) => {
    const src = resolved.get(item.mediaId as MediaId);
    if (src === undefined) throw new APIError("PREVIEW_MEDIA_UNAVAILABLE", 503);
    return publicMediaSchema.parse({
      id: item.mediaId,
      kind: "image",
      src,
      width: item.width,
      height: item.height,
      alt: item.alt,
    });
  });
  const periodLabel = deriveCatalogPeriodLabel({
    ...(content.dynasty === undefined ? {} : { dynasty: content.dynasty }),
    ...(content.dateText === undefined ? {} : { dateText: content.dateText }),
    ...(content.periodLabel === undefined
      ? {}
      : { storedPeriodLabel: content.periodLabel }),
  });
  const representative =
    media[content.media.findIndex(({ isRepresentative }) => isRepresentative)];
  const projection: CatalogDetailProjection = {
    id: content.catalogId,
    kind: content.kind,
    title: content.title,
    aliases: content.aliases.map(({ alias }) => alias),
    ...(content.summary === undefined ? {} : { summary: content.summary }),
    ...(periodLabel === undefined ? {} : { periodLabel }),
    ...(content.dynasty === undefined ? {} : { dynasty: content.dynasty }),
    ...(content.dateText === undefined ? {} : { dateText: content.dateText }),
    ...(content.province === undefined ? {} : { province: content.province }),
    ...(content.prefecture === undefined
      ? {}
      : { prefecture: content.prefecture }),
    ...(content.county === undefined ? {} : { county: content.county }),
    ...(content.currentLocation === undefined
      ? {}
      : { currentLocation: content.currentLocation }),
    ...(content.currentCustodian === undefined
      ? {}
      : { currentCustodian: content.currentCustodian }),
    ...(content.description?.state === "VALUE"
      ? { description: content.description.value }
      : {}),
    ...(content.scriptStyle === undefined
      ? {}
      : { scriptStyle: content.scriptStyle }),
    ...(content.transcription === undefined
      ? {}
      : { transcription: content.transcription }),
    ...(content.historicalContext === undefined
      ? {}
      : { historicalContext: content.historicalContext }),
    ...(content.scholarlyResearch === undefined
      ? {}
      : { scholarlyResearch: content.scholarlyResearch }),
    contributors: content.contributors,
    sourceCitations: content.sourceCitations.map((citation) => ({
      label: citation.label,
      ...(citation.citation === undefined
        ? {}
        : { citation: citation.citation }),
      ...(citation.url === undefined ? {} : { url: citation.url }),
      ...(citation.appliesTo === undefined
        ? {}
        : { appliesTo: citation.appliesTo }),
    })),
    media: [],
  };
  return catalogDetailSchema.parse({
    ...mapCatalogDetail(projection),
    ...(representative === undefined
      ? {}
      : { representativeMedia: representative }),
    media,
  });
}

export const editorialPreviewEndpoint: Endpoint = {
  path: "/editorial/preview/:id",
  method: "get",
  handler: async (req) => {
    try {
      const detail = await previewCatalogDetail(req, req.routeParams?.id);
      return Response.json(detail, { headers: privateHeaders });
    } catch (error) {
      const status =
        error instanceof APIError
          ? error.status
          : error instanceof EditorialError
            ? error.status
            : 500;
      return Response.json(
        {
          error:
            status === 422
              ? "PREVIEW_INCOMPLETE"
              : status === 403
                ? "PREVIEW_AUTHORIZATION_REQUIRED"
                : status === 404
                  ? "PREVIEW_UNAVAILABLE"
                  : "PREVIEW_FAILED",
        },
        { status, headers: privateHeaders },
      );
    }
  },
};
