import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  ADMIN_VIEW_MEDIA_MAX_BYTES,
  adminViewMediaDataSchema,
} from "@moya/contracts/internal/admin-mcp";
import type {
  AdminMcpCode,
  AdminMcpEnvelope,
  AdminMediaRegion,
  AdminViewMediaInput,
} from "@moya/contracts/internal/admin-mcp";
import {
  CATALOG_ORIGINAL_MAX_BYTES,
  CATALOG_ORIGINAL_MAX_PIXELS,
  catalogThumbnailRequestSchema,
} from "@moya/contracts/internal/editorial";
import type { PayloadRequest } from "payload";
import sharp from "sharp";

import {
  CommunityOperatorError,
  openCatalogAiThumbnail,
} from "../../community/backend";
import { failedEnvelope, inputInvalidEnvelope, okEnvelope } from "../envelope";
import { CMS_FAMILIES, findDocuments } from "../records";
import type { RecordDocument } from "../records";

export const VIEW_MEDIA_TOOL_NAME = "admin_view_media";

export const VIEW_MEDIA_DESCRIPTION = `See a Catalog image as a WebP of at most 512 KiB, with original and rendered size in the text. {kind:"catalog_thumb",mediaId:"..."}. One passage of the original, in its pixels: {kind:"catalog_original",mediaId:"...",region:{left,top,width,height}}. Only save a transcription from text you can read; if you cannot read it, say so.`;

export interface AdminMcpImageAnswer {
  readonly envelope: AdminMcpEnvelope;
  readonly image?: { readonly data: Buffer; readonly mimeType: string };
}

const refused = (code: Exclude<AdminMcpCode, "OK">): AdminMcpImageAnswer => ({
  envelope: failedEnvelope(code),
});

const DEFAULT_ORIGINAL_EDGE = 1_600;

/** Each step lowers quality before size: legibility is what this is for. */
const ENCODE_STEPS: readonly { quality: number; scale: number }[] = [
  { quality: 82, scale: 1 },
  { quality: 65, scale: 1 },
  { quality: 50, scale: 1 },
  { quality: 50, scale: 0.75 },
  { quality: 45, scale: 0.5 },
  { quality: 40, scale: 0.35 },
  { quality: 35, scale: 0.25 },
];

interface Rendered {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

const renderBounded = async (
  source: Buffer,
  region: AdminMediaRegion | undefined,
  maxEdge: number | undefined,
): Promise<Rendered | undefined> => {
  for (const { quality, scale } of ENCODE_STEPS) {
    let image = sharp(source, {
      limitInputPixels: CATALOG_ORIGINAL_MAX_PIXELS,
    });
    if (region !== undefined) image = image.extract(region);
    if (maxEdge !== undefined) {
      const edge = Math.max(1, Math.round(maxEdge * scale));
      image = image.resize({
        width: edge,
        height: edge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const { data, info } = await image
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    if (data.byteLength <= ADMIN_VIEW_MEDIA_MAX_BYTES)
      return { data, width: info.width, height: info.height };
  }
  return undefined;
};

const readStream = async (
  body: ReadableStream<Uint8Array> | null,
): Promise<Buffer> => Buffer.from(await new Response(body).arrayBuffer());

/** The same bytes GET /api/media/file/:filename serves, by the row this key can read. */
const readOriginal = async (
  req: PayloadRequest,
  doc: RecordDocument,
): Promise<Buffer | undefined> => {
  const filename = typeof doc.filename === "string" ? doc.filename : undefined;
  if (filename === undefined) return undefined;
  const collection = req.payload.collections.media;
  const upload = collection.config.upload;
  const prefix = typeof doc.prefix === "string" ? doc.prefix : undefined;
  for (const handler of upload.handlers ?? []) {
    const answer = await handler(req, {
      doc: doc as never,
      headers: new Headers(),
      params: {
        collection: "media",
        filename,
        ...(prefix === undefined ? {} : { prefix }),
      },
    });
    if (answer instanceof Response) {
      if (!answer.ok) return undefined;
      const bytes = await readStream(answer.body);
      return bytes.byteLength > CATALOG_ORIGINAL_MAX_BYTES ? undefined : bytes;
    }
  }
  const directory = path.resolve(upload.staticDir ?? "media");
  const file = path.resolve(directory, filename);
  if (!file.startsWith(directory + path.sep)) return undefined;
  try {
    if ((await stat(file)).size > CATALOG_ORIGINAL_MAX_BYTES) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
};

/** Decoding an original costs its whole size in memory, so one at a time. */
let originalInFlight = false;

const backendRefusal = (error: unknown): AdminMcpImageAnswer => {
  if (error instanceof CommunityOperatorError) {
    if (error.code === "AI_CREDENTIAL_NOT_CONFIGURED")
      return refused("AI_CREDENTIAL_NOT_CONFIGURED");
    if (error.code === "AI_ROUTE_FORBIDDEN")
      return refused("AI_ROUTE_FORBIDDEN");
    if (error.status === 404) return refused("NOT_FOUND");
    return refused("MEDIA_UNAVAILABLE");
  }
  throw error;
};

const answered = (
  input: AdminViewMediaInput,
  doc: RecordDocument,
  rendered: Rendered,
): AdminMcpImageAnswer => ({
  envelope: okEnvelope(
    adminViewMediaDataSchema.parse({
      kind: input.kind,
      mediaId: doc.mediaId,
      original: {
        width: typeof doc.width === "number" ? doc.width : null,
        height: typeof doc.height === "number" ? doc.height : null,
      },
      rendered: {
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.data.byteLength,
        format: "webp",
      },
      ...(input.region === undefined ? {} : { region: input.region }),
    }),
  ),
  image: { data: rendered.data, mimeType: "image/webp" },
});

const viewThumbnail = async (
  req: PayloadRequest,
  input: AdminViewMediaInput,
  doc: RecordDocument,
): Promise<AdminMcpImageAnswer> => {
  const request = catalogThumbnailRequestSchema.safeParse({
    mediaId: doc.mediaId,
    objectKey: doc.objectKey,
    sourceSha256: doc.sha256,
  });
  if (!request.success) return refused("MEDIA_UNAVAILABLE");
  let bytes: Buffer;
  try {
    const media = await openCatalogAiThumbnail(
      `catalog-delivery/thumbnail?${new URLSearchParams(request.data)}`,
      null,
      req.signal,
    );
    bytes = await readStream(media.body);
  } catch (error) {
    return backendRefusal(error);
  }
  try {
    if (input.region !== undefined || input.maxEdge !== undefined) {
      const rendered = await renderBounded(bytes, input.region, input.maxEdge);
      return rendered === undefined
        ? refused("MEDIA_UNAVAILABLE")
        : answered(input, doc, rendered);
    }
    const { width, height, format } = await sharp(bytes).metadata();
    return format === "webp"
      ? answered(input, doc, { data: bytes, width, height })
      : refused("MEDIA_UNAVAILABLE");
  } catch {
    // Not a readable image, or a region outside it.
    return refused("MEDIA_UNAVAILABLE");
  }
};

const regionIssue = (region: AdminMediaRegion, doc: RecordDocument) =>
  typeof doc.width === "number" &&
  typeof doc.height === "number" &&
  (region.left + region.width > doc.width ||
    region.top + region.height > doc.height);

const viewOriginal = async (
  req: PayloadRequest,
  input: AdminViewMediaInput,
  doc: RecordDocument,
): Promise<AdminMcpImageAnswer> => {
  if (input.region === undefined)
    return {
      envelope: inputInvalidEnvelope([{ path: ["region"], code: "required" }]),
    };
  if (regionIssue(input.region, doc))
    return {
      envelope: inputInvalidEnvelope([
        { path: ["region"], code: "outside_image" },
      ]),
    };
  if (originalInFlight) return refused("CONCURRENT_OPERATION_BUSY");
  originalInFlight = true;
  try {
    const bytes = await readOriginal(req, doc);
    if (bytes === undefined) return refused("MEDIA_UNAVAILABLE");
    const rendered = await renderBounded(
      bytes,
      input.region,
      input.maxEdge ?? DEFAULT_ORIGINAL_EDGE,
    ).catch(() => undefined);
    return rendered === undefined
      ? refused("MEDIA_UNAVAILABLE")
      : answered(input, doc, rendered);
  } finally {
    originalInFlight = false;
  }
};

export const viewMediaAnswer = async (
  req: PayloadRequest,
  input: AdminViewMediaInput,
): Promise<AdminMcpImageAnswer> => {
  const [doc] = await findDocuments(req, CMS_FAMILIES.media, {
    where: { mediaId: { equals: input.mediaId } },
    limit: 1,
    select: {
      mediaId: true,
      objectKey: true,
      sha256: true,
      width: true,
      height: true,
      filename: true,
      prefix: true,
      mimeType: true,
      filesize: true,
    },
  });
  if (doc === undefined) return refused("NOT_FOUND");
  return input.kind === "catalog_thumb"
    ? viewThumbnail(req, input, doc)
    : viewOriginal(req, input, doc);
};
